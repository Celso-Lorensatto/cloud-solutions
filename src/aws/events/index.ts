import { cloneDeep, defaults, defaultsDeep, intersection, keys, pick } from 'lodash';
import _debug from 'debug';
const debug = _debug('solutions:events');
const log = _debug('solutions:essential:events');

import { sleep } from '../../common/utils/index';
import { EventsInterface } from '../../common/interfaces/events.interface';
import { Events, eventsDefaultOptions } from '../../common/abstract/events';
import { keyFields, libraries, providerConfig } from '../index';

let AWS;

export const sqsDefaultOptions = defaultsDeep(
    {
        listenInterval: 300,
        processInterval: 300,
        params: {
            AttributeNames: ['All'],
            VisibilityTimeout: 120, // em segundos
            WaitTimeSeconds: 0,
        },
    },
    eventsDefaultOptions,
);
export class SQS extends Events implements EventsInterface {
    protected libraries = libraries;
    public defaultOptions: any = cloneDeep(sqsDefaultOptions);
    protected queueUrls: any = {};
    protected instance;
    protected snsInstance;
    protected queueListeners = [];
    protected messagesReceived = [];
    protected messageSlots = 0;
    protected isProcessingMessage = false;

    async initialize(options: any = {}) {
        await super.initialize(options);
        AWS = this.getLibrary('AWS');
        this.checkOptions();

        this.instance = await this.createInstance(this.options);
        this.snsInstance = await this.createSNSInstance(this.options);

        this.options.topicArn = await this.createSNSTopic(this.options.topicName);
        this.options.loadQueues && (await this.options.loadQueues(this));
        this.listenAll();
        // this._reconnecting = false;
    }

    async processReceivedMessages() {
        this.isProcessingMessage = false;
        this.messageSlots = this.getOptions().maxNumberOfMessages;
        const promises = [];
        if (this.messagesReceived.length) {
            this.isProcessingMessage = true;
            let message = null;
            while ((message = this.messagesReceived.shift())) {
                promises.push(this.receiveMessage(message.name, message.handler, message.message, message.options));
                this.messageSlots--;
                if (!this.messageSlots) break;
            }
        }

        if (promises.length) {
            await Promise.all(promises);
            this.isProcessingMessage = false;
        }

        if (this.messagesReceived.length) this.processReceivedMessages();
        else this.listenAll();
    }

    async getInstance(options: any = {}) {
        if (intersection(keys(options), keys(keyFields)).length > 0) {
            const instance = await this.createInstance(options);
            await providerConfig(pick(this.providerOptions, ...keys(keyFields)));
            return instance;
        }
        return this.instance;
    }

    async createInstance(options: any = {}) {
        const keyOptions = pick(options, ...keys(keyFields));
        const keyProviderOptions = pick(this.providerOptions, ...keys(keyFields));
        const providerOptions = defaults(keyOptions, keyProviderOptions);

        await providerConfig(providerOptions);
        const instance = new AWS.SQS({});

        return instance;
    }

    async getSNSInstance(options: any = {}) {
        if (intersection(keys(options), keys(keyFields)).length > 0) {
            const instance = await this.createSNSInstance(options);
            await providerConfig(pick(this.providerOptions, ...keys(keyFields)));
            return instance;
        }
        return this.snsInstance;
    }

    async createSNSInstance(options: any = {}) {
        await providerConfig(defaults(pick(options, ...keys(keyFields)), pick(this.providerOptions, ...keys(keyFields))));

        const instance = new AWS.SNS({});

        return instance;
    }

    checkOptions() {
        if (!this.options.topicName) {
            throw new Error('topic name not specified for events (SNS/SQS)');
        }
        return true;
    }

    async loadQueue(_name, _handler) {
        const names = typeof _name === 'string' ? [_name] : _name;
        for (const _name of names) {
            const name = this.formatQueueName(_name);
            this.queueUrls[name] = await this.createQueue(name);
            debug('loadQueue:queueUrl', this.queueUrls[name]);

            await this.queueSubscribe(this.queueUrls[name]);
            this.queueListeners.push({ name, handler: _handler });
        }
    }

    buildListenerParams(_name) {
        const params: any = {
            ...this.options.params,
            QueueUrl: this.queueUrls[_name],
        };

        if (this.options.maxNumberOfMessages) params.MaxNumberOfMessages = +this.options.maxNumberOfMessages;

        return params;
    }

    async listenAll() {
        await sleep(this.options.listenInterval);
        if (this.queueListeners.length)
            for (const listen of this.queueListeners) {
                await this.listen(listen.name, listen.handler);
            }

        this.processReceivedMessages();
    }

    async listen(_name, _handler) {
        const sqs = await this.getInstance();
        await this._receiveMessages(_name, _handler, sqs);
    }

    _receiveMessages(_name, _handler, instance) {
        return new Promise((resolve, reject) => {
            const params = this.buildListenerParams(_name);
            instance.receiveMessage(params, (error, data) => {
                if (error) {
                    log('loadQueue:receiveMessage', error.message);
                    if (this.options.throwError) throw error;
                    reject(error);
                } else {
                    if (data?.Messages?.length) {
                        for (const message of data.Messages) {
                            this.messagesReceived.push({
                                name: _name,
                                handler: _handler,
                                options: { events: this },
                                message,
                            });
                        }
                    }
                    resolve(true);
                }
            });
        });
    }

    _sendToQueue(_name, data, options: any = {}) {
        const name = this.formatQueueName(_name, options);
        return new Promise((resolve, reject) => {
            this.getQueueUrl(name)
                .then(async (queueUrl) => {
                    const params = {
                        MessageBody: typeof data === 'object' ? JSON.stringify(data) : data + '',
                        QueueUrl: queueUrl,
                    };

                    const sqs = await this.getInstance();
                    sqs.sendMessage(params, (error, data) => {
                        if (error) {
                            debug('_sendToQueue:', 'Erro ao enviar mensagem para a fila:', error.message);
                            if (this.options.throwError) reject(error);
                        } else {
                            debug('_sendToQueue:', 'Mensagem enviada com sucesso:', data.MessageId);
                            resolve(true);
                        }
                    });
                })
                .catch((error) => {
                    reject(error);
                });
        });
    }

    async ack(name, message, options) {
        // Deleta a mensagem da fila
        const deleteParams = {
            QueueUrl: this.queueUrls[name],
            ReceiptHandle: message.ReceiptHandle,
        };

        const sqs = await this.getInstance();
        sqs.deleteMessage(deleteParams, (error, data) => {
            if (error) {
                debug('ack:', error.message);
                if (this.options.throwError) throw error;
            } else {
                debug(`Mensagem ${message.MessageId} deletada da fila`);
            }
        });
    }

    async nack(name, message, options) {
        // debug('Erro ao processar mensagem: ', err);
        // Diminui o tempo de visibilidade da mensagem para que ela seja reprocessada
        const changeParams = {
            QueueUrl: this.queueUrls[name],
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: 0,
        };

        const sqs = await this.getInstance();
        sqs.changeMessageVisibility(changeParams, (error, data) => {
            if (error) {
                debug('Erro ao alterar visibilidade da mensagem: ', error.message);
                if (this.options.throwError) throw error;
            }
            // else {
            // debug('Visibilidade da mensagem alterada: ', message.MessageId);
            // }
        });
    }

    async createSNSTopic(name) {
        const sns = await this.getSNSInstance();
        return new Promise((resolve, reject) => {
            this.findTopic(name)
                .then((topicArn) => {
                    if (topicArn) {
                        // debug(`A fila ${name} já existe (${queueUrl})`);
                        resolve(topicArn);
                    } else {
                        sns.createTopic({ Name: name }, (error, data) => {
                            if (error) {
                                log('Erro ao criar tópico: ', error.message);
                                if (this.options.throwError) throw error;
                                reject(error);
                                // this.createTopicOnFail(name).then((topicArn) => resolve(topicArn));
                            } else {
                                // debug(`Tópico criado com sucesso: ${data.TopicArn}`);
                                resolve(data.TopicArn);
                            }
                        });
                    }
                })
                .catch((error) => {
                    log('createSNSTopic:', error);
                    reject(error);
                });
        });
    }

    async createTopicOnFail(name) {
        await sleep(this.options.retryInterval);
        return await this.createSNSTopic(name);
    }

    async findTopic(name) {
        const sns = await this.getSNSInstance();
        return new Promise((resolve, reject) => {
            sns.listTopics({}, (error, data) => {
                if (error) {
                    debug('Erro ao listar tópicos: ', error.message);
                    if (this.options.throwError) throw error;
                    // reject(error);
                    reject();
                } else {
                    let topicArn = '';
                    data.Topics.some((topic) => {
                        const found = topic.TopicArn.includes(name);
                        if (found) topicArn = topic.TopicArn;
                        return found;
                    });
                    resolve(topicArn);
                }
            });
        });
    }

    async createQueue(name, options: any = {}) {
        const sqs = await this.getInstance();
        const createQueue = (resolve, reject) => {
            // Se a fila não existe, cria uma nova fila
            sqs.createQueue({ QueueName: name }, (error, data) => {
                if (error) {
                    log('createQueue:', error.message);
                    if (this.options.throwError) throw error;
                    reject(error);
                    // this.createQueueOnFail(name).then((queueUrl) => resolve(queueUrl));
                } else {
                    const queueUrl = data.QueueUrl;
                    // debug(`A fila ${name} foi criada com sucesso (${queueUrl})`);
                    resolve(queueUrl);
                }
            });
        };
        return new Promise((resolve, reject) => {
            // Verifica se a fila já existe
            this.findQueueUrl(name)
                .then((queueUrl) => {
                    if (queueUrl) {
                        // debug(`A fila ${name} já existe (${queueUrl})`);
                        resolve(queueUrl);
                    } else {
                        createQueue(resolve, reject);
                    }
                })
                .catch(() => {
                    createQueue(resolve, reject);
                });
        });
    }

    async createQueueOnFail(name) {
        await sleep(this.options.retryInterval);
        return await this.createQueue(name);
    }

    async getQueueUrl(name) {
        if (!this.queueUrls[name]) this.queueUrls[name] = await this.findQueueUrl(name);
        return this.queueUrls[name];
    }

    async findQueueUrl(name) {
        const sqs = await this.getInstance();
        return new Promise((resolve, reject) => {
            // Verifica se a fila já existe
            sqs.listQueues({ QueueNamePrefix: name }, (error, data) => {
                if (error) {
                    debug('findQueueUrl:', error.message);
                    if (this.options.throwError) throw error;
                    reject(error);
                } else {
                    // Se a fila já existe, utiliza a URL da fila existente
                    if (data.QueueUrls && data.QueueUrls.length > 0) {
                        const queueUrl = data.QueueUrls[0];
                        resolve(queueUrl);
                    } else {
                        reject(new Error(`Url da fila "${name}" não encontrada`));
                    }
                }
            });
        });
    }

    queueUrlToARN(_queueUrl) {
        if (/https/.test(_queueUrl)) {
            return _queueUrl.replace(/^(https:\/\/)(\w+)\.([\w-]+)\.([\w.]+)\/(\w+)\/([\w-]+)$/, 'arn:aws:$2:$3:$5:$6');
        }
        return _queueUrl;
    }

    async queueSubscribe(_queueUrl) {
        const sns = await this.getSNSInstance();
        return new Promise((resolve, reject) => {
            const queueUrl = this.queueUrlToARN(_queueUrl);
            sns.subscribe(
                {
                    Protocol: 'sqs',
                    TopicArn: this.options.topicArn,
                    Endpoint: queueUrl,
                },
                (error, data) => {
                    if (error) {
                        debug('queueSubscribe:', error.message);
                        if (this.options.throwError) throw error;
                        reject(error);
                    } else {
                        // debug(`Fila inscrita no tópico ${this.options.topicArn}`);
                        resolve(true);
                    }
                },
            );
        });
    }
}
