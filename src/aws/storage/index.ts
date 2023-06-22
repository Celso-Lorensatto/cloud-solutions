import _debug from 'debug';
const debug = _debug('solutions:storage:aws');

import _ from 'lodash';
import AWS from 'aws-sdk';
import { createInterface } from 'readline';
import stream from 'stream';

import { StorageOutputEnum } from '../../common/types/storageOutput.enum';
import { StorageInterface } from '../../common/interfaces/storage.interface';
import { Storage } from '../../common/abstract/storage';
import { providerConfig, keyFields } from '../index';
import { WriteStream } from './writeStream';

export class S3 extends Storage implements StorageInterface {
    protected instance;

    async initialize(options: any = {}) {
        super.initialize(options);
        this.checkOptions();
        this.instance = this.createInstance(options);
    }

    getInstance(options: any = {}) {
        if (_.intersection(_.keys(options), _.keys(keyFields)).length > 0) {
            const instance = this.createInstance(options);
            providerConfig(_.pick(this.providerOptions, ..._.keys(keyFields)));
            return instance;
        }
        return this.instance;
    }

    createInstance(options: any = {}) {
        providerConfig(this.mergeProviderOptions(options, keyFields));

        const instance = new AWS.S3({});

        return instance;
    }

    async readContent(path, options: any = {}) {
        this.isInitialized();
        const storage = this.getInstance(options);

        const storageParams = {
            ...this.getOptions(),
            ..._.omit(options, ..._.keys(keyFields)),
            Key: path,
        };

        const data = await storage.getObject(storageParams).promise();
        return data?.Body.toString(options.charset || 'utf-8');
    }

    async readStream(path, options: any = {}) {
        this.isInitialized();
        const storage = this.getInstance(options);

        const storageParams = {
            ...this.getOptions(),
            ..._.omit(options, ..._.keys(keyFields)),
            Key: path,
        };

        const data = storage.getObject(storageParams).createReadStream();
        const rl = createInterface({
            input: data,
            crlfDelay: Infinity,
        });

        return rl;
    }

    async _sendContent(filePath, content, params: any = {}) {
        this.isInitialized();
        const storage = this.getInstance(params);

        // Configura as opções do upload
        const uploadParams = {
            ...this.getOptions(),
            Key: filePath,
            Body: typeof content === 'string' ? Buffer.from(content) : content,
            ..._.omit(params, 'options', ..._.keys(keyFields)),
        };

        await storage.upload(uploadParams, params.options || {}).promise();
        debug(`Os dados foram escritos em ${filePath}`);
    }

    sendStream(filePath, params: any = {}) {
        this.isInitialized();
        const storage = this.getInstance(params);

        const _stream = new stream.PassThrough();
        // Configura as opções do upload
        const uploadParams = {
            ...this.getOptions(),
            Key: filePath,
            Body: _stream,
            ..._.omit(params, 'options', ..._.keys(keyFields)),
        };

        const upload = storage
            .upload(uploadParams, {
                queueSize: 4, // optional concurrency configuration
                partSize: 5 * 1024 * 1024, // optional size of each part
                leavePartsOnError: true, // optional manually handle dropped parts
                ...(params.options || {}),
            })
            .promise();

        return new WriteStream(_stream, { filePath, upload });
    }

    async deleteFile(filePath, options: any = {}) {
        this.isInitialized();
        const storage = this.getInstance(options);
        await storage
            .deleteObject({
                ...this.getOptions(),
                Key: filePath,
            })
            .promise();
        debug(`O arquivo ${filePath} foi excluído`);

        return StorageOutputEnum.Success;
    }

    async deleteDirectory(directoryPath, options: any = {}) {
        this.isInitialized();
        const storage = this.getInstance(options);

        const objects = await storage
            .listObjectsV2({
                ...this.getOptions(),
                Prefix: directoryPath,
                ...options,
            })
            .promise();

        const deleteParams = {
            ...this.getOptions(),
            Delete: { Objects: objects.Contents.map(({ Key }) => ({ Key })) },
        };

        await storage.deleteObjects(deleteParams).promise();

        if (objects.IsTruncated) {
            await this.deleteDirectory(directoryPath);
        } else {
            await storage
                .deleteObject({
                    ...this.getOptions(),
                    Key: directoryPath,
                })
                .promise();
        }
        return StorageOutputEnum.Success;
    }

    async readDirectory(directoryPath = '', _options: any = {}) {
        this.isInitialized();
        const storage = this.getInstance(_options);

        const options: any = {
            ...this.getOptions(),
            ..._.omit(_options, ..._.keys(keyFields)),
        };
        directoryPath && (options.Prefix = directoryPath);

        const objects = await storage.listObjectsV2(options).promise();

        return _.map(objects?.Contents, (item) => item.Key);
    }

    async checkDirectoryExists(directoryPath = '', options: any = {}) {
        const objects = await this.readDirectory(directoryPath, options);
        return objects?.length > 0;
    }
}
