import _debug from 'debug';
const debug = _debug('solutions:events');
const log = _debug('solutions:essential:events');

import { sleep } from '../utils/index';
import { Solution } from './solution';
import { cloneDeep, defaultsDeep } from 'lodash';

export const eventsDefaultOptions = {
    retryInterval: 5000,
    retryLimit: 3,
    maxNumberOfMessages: 1,
};

export abstract class Events extends Solution {
    protected _isConnected = false;
    public defaultOptions: any = cloneDeep(eventsDefaultOptions);

    async sendToQueue(_name, data, options: any = {}) {
        const _options = defaultsDeep(options, { retry: this.getOptions().retryLimit });
        try {
            !data && (data = {});
            await this._sendToQueue(_name, data, _options);
        } catch (error) {
            if (_options.retry > 0) {
                const retryInterval = this.getOptions().retryInterval;
                debug(`@${process.pid} Retrying sendToQueue`, retryInterval, error.message);
                await sleep(retryInterval);
                _options.retry--;
                return await this.sendToQueue(_name, data, _options);
            }
            throw error;
        }
    }

    async _sendToQueue(_name, data, options: any = {}): Promise<any> {
        return { _name, data, options };
    }

    getMessageBody(message) {
        return message.Body || message.content || '{}';
    }

    formatMessageBody(message) {
        const body = this.getMessageBody(message);
        try {
            if (/^[[{]/.test(body)) return JSON.parse(body);
            return body;
        } catch (error) {
            debug('JSON Parse error at formatMessageBody:', error.message);
            return false;
        }
    }

    async receiveMessage(name, handler, message, options) {
        debug(`@${process.pid} Executing Queue ${name}`);
        const body = this.formatMessageBody(message);
        if (body === false) {
            debug(`@${process.pid} Aborting Queue`);
            return await this.ack(name, message, options);
        }

        try {
            const result = await handler(body, {
                events: options.events,
                name,
            });
            if (result !== false) return await this.ack(name, message, options);
        } catch (error) {
            await this.nack(name, message, options);
            debug(`@${process.pid} Error on Queue:`);
            debug(`Code: ${error.code}; Status: ${error.status}; Message: ${error.message}`);
            if (options.events.getOptions().throwError) {
                debug(`Trace:`);
                throw error;
            }
            return;
        }
        await this.nack(name, message, options);
    }

    getPrefix(options: any = {}) {
        return (options.prefix || this.getOptions().prefix || '').trim();
    }

    formatQueueName(_name, options: any = {}) {
        const prefix = this.getPrefix(options);

        const parts = [];
        if (prefix) parts.push(prefix);
        parts.push(_name);

        const name = parts.join('-').replace(/\//g, '-');
        return name;
    }

    isConnected() {
        return this._isConnected;
    }

    abstract ack(name, message, options): any;
    abstract nack(name, message, options): any;
}
