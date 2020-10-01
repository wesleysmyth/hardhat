import { BN, bufferToHex } from "ethereumjs-util";
import fsExtra from "fs-extra";
import * as t from "io-ts";
import path from "path";

import { HttpProvider } from "../../core/providers/http";
import { createNonCryptographicHashBasedIdentifier } from "../../util/hash";
import { rpcData, rpcQuantity } from "../provider/input";
import { numberToRpcQuantity } from "../provider/output";

import {
  decode,
  nullable,
  RpcBlock,
  rpcBlock,
  rpcBlockWithTransactions,
  RpcBlockWithTransactions,
  rpcLog,
  rpcTransaction,
  rpcTransactionReceipt,
} from "./types";

export class JsonRpcClient {
  private _cache: Map<string, any> = new Map();
  private _scopedForkCacheFolderCreated?: boolean;

  constructor(
    private _httpProvider: HttpProvider,
    private _networkId: number,
    private _latestBlockNumberOnCreation: number,
    private _maxReorg: number,
    private _forkCachePath?: string
  ) {}

  public getNetworkId(): number {
    return this._networkId;
  }

  public async getStorageAt(
    address: Buffer,
    position: Buffer,
    blockNumber: BN
  ): Promise<Buffer> {
    return this._perform(
      "eth_getStorageAt",
      [
        bufferToHex(address),
        bufferToHex(position),
        numberToRpcQuantity(blockNumber),
      ],
      rpcData,
      () => blockNumber
    );
  }

  public async getBlockByNumber(
    blockNumber: BN,
    includeTransactions?: false
  ): Promise<RpcBlock | null>;

  public async getBlockByNumber(
    blockNumber: BN,
    includeTransactions: true
  ): Promise<RpcBlockWithTransactions | null>;

  public async getBlockByNumber(
    blockNumber: BN,
    includeTransactions = false
  ): Promise<RpcBlock | RpcBlockWithTransactions | null> {
    if (includeTransactions) {
      return this._perform(
        "eth_getBlockByNumber",
        [numberToRpcQuantity(blockNumber), true],
        nullable(rpcBlockWithTransactions),
        (block) => block?.number ?? undefined
      );
    }

    return this._perform(
      "eth_getBlockByNumber",
      [numberToRpcQuantity(blockNumber), false],
      nullable(rpcBlock),
      (block) => block?.number ?? undefined
    );
  }

  public async getBlockByHash(
    blockHash: Buffer,
    includeTransactions?: false
  ): Promise<RpcBlock | null>;

  public async getBlockByHash(
    blockHash: Buffer,
    includeTransactions: true
  ): Promise<RpcBlockWithTransactions | null>;

  public async getBlockByHash(
    blockHash: Buffer,
    includeTransactions = false
  ): Promise<RpcBlock | RpcBlockWithTransactions | null> {
    if (includeTransactions) {
      return this._perform(
        "eth_getBlockByHash",
        [bufferToHex(blockHash), true],
        nullable(rpcBlockWithTransactions),
        (block) => block?.number ?? undefined
      );
    }

    return this._perform(
      "eth_getBlockByHash",
      [bufferToHex(blockHash), false],
      nullable(rpcBlock),
      (block) => block?.number ?? undefined
    );
  }

  public async getTransactionByHash(transactionHash: Buffer) {
    return this._perform(
      "eth_getTransactionByHash",
      [bufferToHex(transactionHash)],
      nullable(rpcTransaction),
      (tx) => tx?.blockNumber ?? undefined
    );
  }

  public async getTransactionReceipt(transactionHash: Buffer) {
    return this._perform(
      "eth_getTransactionReceipt",
      [bufferToHex(transactionHash)],
      nullable(rpcTransactionReceipt),
      (tx) => tx?.blockNumber ?? undefined
    );
  }

  public async getLogs(options: {
    fromBlock: BN;
    toBlock: BN;
    address?: Buffer | Buffer[];
    topics?: Array<Array<Buffer | null> | null>;
  }) {
    let address: string | string[] | undefined;
    if (options.address !== undefined) {
      address = Array.isArray(options.address)
        ? options.address.map((x) => bufferToHex(x))
        : bufferToHex(options.address);
    }
    let topics: Array<Array<string | null> | null> | undefined;
    if (options.topics !== undefined) {
      topics = options.topics.map((items) =>
        items !== null
          ? items.map((x) => (x !== null ? bufferToHex(x) : x))
          : null
      );
    }

    return this._perform(
      "eth_getLogs",
      [
        {
          fromBlock: numberToRpcQuantity(options.fromBlock),
          toBlock: numberToRpcQuantity(options.toBlock),
          address,
          topics,
        },
      ],
      t.array(rpcLog, "RpcLog Array"),
      () => options.toBlock
    );
  }

  public async getAccountData(
    address: Buffer,
    blockNumber: BN
  ): Promise<{ code: Buffer; transactionCount: BN; balance: BN }> {
    const results = await this._performBatch(
      [
        {
          method: "eth_getCode",
          params: [bufferToHex(address), numberToRpcQuantity(blockNumber)],
          tType: rpcData,
        },
        {
          method: "eth_getTransactionCount",
          params: [bufferToHex(address), numberToRpcQuantity(blockNumber)],
          tType: rpcQuantity,
        },
        {
          method: "eth_getBalance",
          params: [bufferToHex(address), numberToRpcQuantity(blockNumber)],
          tType: rpcQuantity,
        },
      ],
      () => blockNumber
    );

    return {
      code: results[0],
      transactionCount: results[1],
      balance: results[2],
    };
  }

  private async _perform<T>(
    method: string,
    params: any[],
    tType: t.Type<T>,
    getMaxAffectedBlockNumber: (decodedResult: T) => BN | undefined
  ): Promise<T> {
    const cacheKey = this._getCacheKey(method, params);

    const cachedResult = this._getFromCache(cacheKey);
    if (cachedResult !== undefined) {
      return cachedResult;
    }

    const diskCachedResult = await this._getFromDiskCache(cacheKey, tType);
    if (diskCachedResult !== undefined) {
      this._storeInCache(cacheKey, diskCachedResult);
      return diskCachedResult;
    }

    const rawResult = await this._send(method, params);
    const decodedResult = decode(rawResult, tType);

    const blockNumber = getMaxAffectedBlockNumber(decodedResult);
    if (this._canBeCached(blockNumber)) {
      this._storeInCache(cacheKey, decodedResult);

      if (this._isCacheToDiskEnabled()) {
        await this._storeInDiskCache(cacheKey, rawResult);
      }
    }

    return decodedResult;
  }

  private async _performBatch(
    batch: Array<{
      method: string;
      params: any[];
      tType: t.Type<any>;
    }>,
    getMaxAffectedBlockNumber: (decodedResults: any[]) => BN | undefined
  ): Promise<any[]> {
    // Perform Batch caches the entire batch at once.
    // It could implement something more clever, like caching per request
    // but it's only used in one place, and those other requests aren't
    // used anywhere else.
    const cacheKey = this._getBatchCacheKey(batch);

    const cachedResult = this._getFromCache(cacheKey);
    if (cachedResult !== undefined) {
      return cachedResult;
    }

    const diskCachedResult = await this._getBatchFromDiskCache(
      cacheKey,
      batch.map((b) => b.tType)
    );

    if (diskCachedResult !== undefined) {
      this._storeInCache(cacheKey, diskCachedResult);
      return diskCachedResult;
    }

    const rawResults = await this._sendBatch(batch);
    const decodedResults = rawResults.map((result, i) =>
      decode(result, batch[i].tType)
    );

    const blockNumber = getMaxAffectedBlockNumber(decodedResults);
    if (this._canBeCached(blockNumber)) {
      this._storeInCache(cacheKey, decodedResults);

      if (this._isCacheToDiskEnabled()) {
        await this._storeInDiskCache(cacheKey, rawResults);
      }
    }

    return decodedResults;
  }

  private async _send(
    method: string,
    params: any[],
    isRetryCall = false
  ): Promise<any> {
    try {
      return await this._httpProvider.request({ method, params });
    } catch (err) {
      if (this._shouldRetry(isRetryCall, err)) {
        return this._send(method, params, true);
      }
      // tslint:disable-next-line only-hardhat-error
      throw err;
    }
  }

  private async _sendBatch(
    batch: Array<{ method: string; params: any[] }>,
    isRetryCall = false
  ): Promise<any[]> {
    try {
      return await this._httpProvider.sendBatch(batch);
    } catch (err) {
      if (this._shouldRetry(isRetryCall, err)) {
        return this._sendBatch(batch, true);
      }
      // tslint:disable-next-line only-hardhat-error
      throw err;
    }
  }

  private _shouldRetry(isRetryCall: boolean, err: any) {
    return (
      !isRetryCall &&
      this._httpProvider.url.includes("infura") &&
      err instanceof Error &&
      err.message.includes("header not found")
    );
  }

  private _getCacheKey(method: string, params: any[]) {
    const networkId = this.getNetworkId();
    const plaintextKey = `${networkId} ${method} ${JSON.stringify(params)}`;

    const hashed = createNonCryptographicHashBasedIdentifier(
      Buffer.from(plaintextKey, "utf8")
    );

    return hashed.toString("hex");
  }

  private _getBatchCacheKey(batch: Array<{ method: string; params: any[] }>) {
    let fakeMethod = "";
    const fakeParams = [];

    for (const entry of batch) {
      fakeMethod += entry.method;
      fakeParams.push(...entry.params);
    }

    return this._getCacheKey(fakeMethod, fakeParams);
  }

  private _getFromCache(cacheKey: string): any | undefined {
    return this._cache.get(cacheKey);
  }

  private _storeInCache(cacheKey: string, decodedResult: any) {
    this._cache.set(cacheKey, decodedResult);
  }

  private async _getFromDiskCache(
    cacheKey: string,
    tType: t.Type<any>
  ): Promise<any | undefined> {
    const rawResult = await this._getRawFromDiskCache(cacheKey);

    if (rawResult !== undefined) {
      return decode(rawResult, tType);
    }
  }

  private async _getBatchFromDiskCache(
    cacheKey: string,
    tTypes: Array<t.Type<any>>
  ): Promise<any[] | undefined> {
    const rawResults = await this._getRawFromDiskCache(cacheKey);

    if (!Array.isArray(rawResults)) {
      return undefined;
    }

    return rawResults.map((r, i) => decode(r, tTypes[i]));
  }

  private async _getRawFromDiskCache(
    cacheKey: string
  ): Promise<any | undefined> {
    try {
      return await fsExtra.readJSON(this._getDiskCachePathForKey(cacheKey), {
        encoding: "utf8",
      });
    } catch (error) {
      return undefined;
    }
  }

  private async _storeInDiskCache(cacheKey: string, rawResult: any) {
    const requestPath = this._getDiskCachePathForKey(cacheKey);

    if (this._scopedForkCacheFolderCreated !== true) {
      this._scopedForkCacheFolderCreated = true;
      await fsExtra.ensureDir(path.dirname(requestPath));
    }

    await fsExtra.writeJSON(requestPath, rawResult, {
      encoding: "utf8",
    });
  }

  private _getDiskCachePathForKey(key: string): string {
    return path.join(
      this._forkCachePath!,
      `network-${this._networkId!}`,
      `request-${key}.json`
    );
  }

  private _isCacheToDiskEnabled() {
    return this._forkCachePath !== undefined;
  }

  private _canBeCached(blockNumber: BN | undefined) {
    if (blockNumber === undefined) {
      return false;
    }

    return !this._canBeReorgedOut(blockNumber.toNumber());
  }

  private _canBeReorgedOut(blockNumber: number) {
    return blockNumber > this._latestBlockNumberOnCreation - this._maxReorg;
  }
}
