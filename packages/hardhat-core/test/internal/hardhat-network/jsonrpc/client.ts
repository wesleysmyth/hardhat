import { assert } from "chai";
import { BN, toBuffer } from "ethereumjs-util";
import fsExtra from "fs-extra";
import sinon from "sinon";

import { HttpProvider } from "../../../../src/internal/core/providers/http";
import { JsonRpcClient } from "../../../../src/internal/hardhat-network/jsonrpc/client";
import { RpcTransaction } from "../../../../src/internal/hardhat-network/jsonrpc/types";
import { randomHashBuffer } from "../../../../src/internal/hardhat-network/provider/fork/random";
import { makeForkClient } from "../../../../src/internal/hardhat-network/provider/utils/makeForkClient";
import { useTmpDir } from "../../../helpers/fs";
import {
  BLOCK_HASH_OF_10496585,
  BLOCK_NUMBER_OF_10496585,
  DAI_ADDRESS,
  DAI_CONTRACT_LENGTH,
  DAI_TOTAL_SUPPLY_STORAGE_POSITION,
  EMPTY_ACCOUNT_ADDRESS,
  FIRST_TX_HASH_OF_10496585,
} from "../helpers/constants";
import { FORKED_PROVIDERS } from "../helpers/providers";

type FakeProvider = Pick<HttpProvider, "url" | "sendBatch"> & {
  request: sinon.SinonStub | HttpProvider["request"];
};

describe("JsonRpcClient", () => {
  describe("Using fake providers", function () {
    describe("Caching", () => {
      const response1 =
        "0x00000000000000000000000000000000000000000067bafa8fb7228f04ffa792";
      const response2 =
        "0x00000000000000000000000000000000000000000067bafa8fb7228f04ffa793";

      let fakeProvider: FakeProvider;
      let clientWithFakeProvider: JsonRpcClient;

      function getStorageAt(blockNumber: number) {
        return clientWithFakeProvider.getStorageAt(
          DAI_ADDRESS,
          DAI_TOTAL_SUPPLY_STORAGE_POSITION,
          new BN(blockNumber)
        );
      }

      beforeEach(async function () {
        fakeProvider = {
          request: sinon.stub().resolves(response1),
          url: "fake",
          sendBatch: () => Promise.resolve([]),
        };
      });

      it("Doesn't cache things for blocks that can be reorg'd out", async () => {
        clientWithFakeProvider = new JsonRpcClient(
          fakeProvider as any,
          1,
          123,
          3
        );

        const value = await getStorageAt(121);
        await getStorageAt(121);

        assert.isTrue((fakeProvider.request as sinon.SinonStub).calledTwice);
        assert.isTrue(value.equals(toBuffer(response1)));
      });

      it("caches fetched data when its safe", async () => {
        clientWithFakeProvider = new JsonRpcClient(
          fakeProvider as any,
          1,
          123,
          3
        );

        const value = await getStorageAt(120);
        await getStorageAt(120);

        assert.isTrue((fakeProvider.request as sinon.SinonStub).calledOnce);
        assert.isTrue(value.equals(toBuffer(response1)));
      });

      it("is parameter aware", async () => {
        fakeProvider = {
          request: sinon
            .stub()
            .onFirstCall()
            .resolves(response1)
            .onSecondCall()
            .resolves(response2),
          url: "fake",
          sendBatch: () => Promise.resolve([]),
        };

        clientWithFakeProvider = new JsonRpcClient(
          fakeProvider as any,
          1,
          123,
          3
        );

        const firstResponse110 = await getStorageAt(110);

        const firstResponse120 = await getStorageAt(120);

        const secondResponse120 = await getStorageAt(120);

        const secondResponse110 = await getStorageAt(110);

        assert.isTrue(firstResponse110.equals(secondResponse110));
        assert.isTrue(firstResponse120.equals(secondResponse120));

        assert.isTrue(firstResponse110.equals(toBuffer(response1)));
        assert.isTrue(firstResponse120.equals(toBuffer(response2)));
      });

      describe("Disk caching", () => {
        useTmpDir("hardhat-network-forking-disk-cache");

        beforeEach(function () {
          clientWithFakeProvider = new JsonRpcClient(
            fakeProvider as any,
            1,
            123,
            3,
            this.tmpDir
          );
        });

        async function makeCall() {
          const value = await getStorageAt(120);
          await getStorageAt(120);

          assert.isTrue((fakeProvider.request as sinon.SinonStub).calledOnce);
          assert.isTrue(value.equals(toBuffer(response1)));
        }

        it("Stores to disk after a request", async function () {
          await makeCall();
          assert.lengthOf(await fsExtra.readdir(this.tmpDir), 1);
        });

        it("Reads from disk if available, not making any request a request", async function () {
          await makeCall();
          assert.isTrue((fakeProvider.request as sinon.SinonStub).calledOnce);

          clientWithFakeProvider = new JsonRpcClient(
            fakeProvider as any,
            1,
            123,
            3,
            this.tmpDir
          );

          await makeCall();
          assert.isTrue((fakeProvider.request as sinon.SinonStub).calledOnce);
        });
      });
    });

    describe("Retry on Infura's error", () => {
      const fakeInfuraUrl = "http://infura.com";

      const response =
        "0x00000000000000000000000000000000000000000067bafa8fb7228f04ffa792";

      it("makes a retry on the 'header not found' error", async () => {
        const fakeProvider: FakeProvider = {
          url: fakeInfuraUrl,
          request: sinon
            .stub()
            .onFirstCall()
            .rejects(new Error("header not found"))
            .onSecondCall()
            .resolves(response),
          sendBatch: () => Promise.resolve([]),
        };

        const clientWithFakeProvider = new JsonRpcClient(
          fakeProvider as any,
          1,
          123,
          3
        );
        const value = await clientWithFakeProvider.getStorageAt(
          DAI_ADDRESS,
          DAI_TOTAL_SUPPLY_STORAGE_POSITION,
          new BN(120)
        );
        assert.equal((fakeProvider.request as sinon.SinonStub).callCount, 2);
        assert.isTrue(value.equals(toBuffer(response)));
      });

      it("does not retry more than once", async () => {
        const fakeProvider: FakeProvider = {
          url: fakeInfuraUrl,
          request: sinon
            .stub()
            .onFirstCall()
            .rejects(new Error("header not found"))
            .onSecondCall()
            .rejects(new Error("header not found"))
            .onCall(4)
            .resolves(response),
          sendBatch: () => Promise.resolve([]),
        };

        const clientWithFakeProvider = new JsonRpcClient(
          fakeProvider as any,
          1,
          123,
          3
        );

        await assert.isRejected(
          clientWithFakeProvider.getStorageAt(
            DAI_ADDRESS,
            DAI_TOTAL_SUPPLY_STORAGE_POSITION,
            new BN(120)
          ),
          "header not found"
        );
      });

      it("does not retry on a different error", async () => {
        const fakeProvider: FakeProvider = {
          url: fakeInfuraUrl,
          request: sinon
            .stub()
            .onFirstCall()
            .rejects(new Error("different error"))
            .onSecondCall()
            .resolves(response),
          sendBatch: () => Promise.resolve([]),
        };

        const clientWithFakeProvider = new JsonRpcClient(
          fakeProvider as any,
          1,
          123,
          3
        );
        await assert.isRejected(
          clientWithFakeProvider.getStorageAt(
            DAI_ADDRESS,
            DAI_TOTAL_SUPPLY_STORAGE_POSITION,
            new BN(120)
          ),
          "different error"
        );
      });

      it("does not retry when other RPC provider is used", async () => {
        const fakeProvider: FakeProvider = {
          url: "other",
          request: sinon
            .stub()
            .onFirstCall()
            .rejects(new Error("header not found"))
            .onSecondCall()
            .resolves(response),
          sendBatch: () => Promise.resolve([]),
        };

        const clientWithFakeProvider = new JsonRpcClient(
          fakeProvider as any,
          1,
          123,
          3
        );
        await assert.isRejected(
          clientWithFakeProvider.getStorageAt(
            DAI_ADDRESS,
            DAI_TOTAL_SUPPLY_STORAGE_POSITION,
            new BN(120)
          ),
          "header not found"
        );
      });
    });
  });

  describe("Using actual providers", function () {
    FORKED_PROVIDERS.forEach(({ rpcProvider, jsonRpcUrl }) => {
      describe(`Using ${rpcProvider}`, () => {
        let client: JsonRpcClient;
        let forkNumber: BN;

        beforeEach(async () => {
          const clientResult = await makeForkClient({ jsonRpcUrl });
          client = clientResult.forkClient;
          forkNumber = clientResult.forkBlockNumber;
        });

        describe("Basic tests", () => {
          it("can be constructed", () => {
            assert.instanceOf(client, JsonRpcClient);
          });

          it("can actually fetch real json-rpc", async () => {
            // This is just a random tx from mainnet
            const tx = await client.getTransactionByHash(
              toBuffer(
                "0xc008e9f9bb92057dd0035496fbf4fb54f66b4b18b370928e46d6603933054d5a"
              )
            );

            const blockNumber = tx?.blockNumber?.toNumber();
            assert.isNotNull(blockNumber);
            assert.isAtLeast(blockNumber as number, 10964958);
          });
        });

        describe("eth_getBlockByNumber", () => {
          it("can fetch the data with transaction hashes", async () => {
            const block = await client.getBlockByNumber(
              BLOCK_NUMBER_OF_10496585
            );
            assert.isTrue(block?.hash?.equals(BLOCK_HASH_OF_10496585));
            assert.equal(block?.transactions.length, 192);
            assert.isTrue(
              block?.transactions.every(
                (tx: Buffer | RpcTransaction) => tx instanceof Buffer
              )
            );
          });

          it("can fetch the data with transactions", async () => {
            const block = await client.getBlockByNumber(
              BLOCK_NUMBER_OF_10496585,
              true
            );
            assert.isTrue(
              block?.transactions.every(
                (tx: Buffer | RpcTransaction) => !(tx instanceof Buffer)
              )
            );
          });

          it("returns null for non-existent block", async () => {
            const block = await client.getBlockByNumber(
              forkNumber.addn(1000),
              true
            );
            assert.isNull(block);
          });
        });

        describe("eth_getBlockByHash", () => {
          it("can fetch the data with transaction hashes", async () => {
            const block = await client.getBlockByHash(BLOCK_HASH_OF_10496585);
            assert.isTrue(block?.hash?.equals(BLOCK_HASH_OF_10496585));
            assert.equal(block?.transactions.length, 192);
            assert.isTrue(
              block?.transactions.every(
                (tx: Buffer | RpcTransaction) => tx instanceof Buffer
              )
            );
          });

          it("can fetch the data with transactions", async () => {
            const block = await client.getBlockByHash(
              BLOCK_HASH_OF_10496585,
              true
            );
            assert.isTrue(
              block?.transactions.every(
                (tx: Buffer | RpcTransaction) => !(tx instanceof Buffer)
              )
            );
          });

          it("returns null for non-existent block", async () => {
            const block = await client.getBlockByHash(randomHashBuffer(), true);
            assert.isNull(block);
          });
        });

        describe("eth_getStorageAt", () => {
          it("can fetch value from storage of an existing contract", async () => {
            const totalSupply = await client.getStorageAt(
              DAI_ADDRESS,
              DAI_TOTAL_SUPPLY_STORAGE_POSITION,
              forkNumber
            );
            const totalSupplyBN = new BN(totalSupply);
            assert.isTrue(totalSupplyBN.gtn(0));
          });

          it("can fetch empty value from storage of an existing contract", async () => {
            const value = await client.getStorageAt(
              DAI_ADDRESS,
              toBuffer("0xbaddcafe"),
              forkNumber
            );
            const valueBN = new BN(value);
            assert.isTrue(valueBN.eqn(0));
          });

          it("can fetch empty value from storage of a non-existent contract", async () => {
            const value = await client.getStorageAt(
              EMPTY_ACCOUNT_ADDRESS,
              toBuffer([1]),
              forkNumber
            );
            const valueBN = new BN(value);
            assert.isTrue(valueBN.eqn(0));
          });
        });

        describe("getTransactionByHash", () => {
          it("can fetch existing transactions", async () => {
            const transaction = await client.getTransactionByHash(
              FIRST_TX_HASH_OF_10496585
            );
            assert.isTrue(transaction?.hash.equals(FIRST_TX_HASH_OF_10496585));
            assert.isTrue(
              transaction?.blockHash?.equals(BLOCK_HASH_OF_10496585)
            );
          });

          it("returns null for non-existent transactions", async () => {
            const transaction = await client.getTransactionByHash(
              randomHashBuffer()
            );
            assert.equal(transaction, null);
          });
        });

        describe("getTransactionReceipt", () => {
          it("can fetch existing receipts", async () => {
            const receipt = await client.getTransactionReceipt(
              FIRST_TX_HASH_OF_10496585
            );
            assert.isTrue(
              receipt?.transactionHash.equals(FIRST_TX_HASH_OF_10496585)
            );
            assert.isTrue(receipt?.transactionIndex?.eqn(0));
            assert.isTrue(receipt?.blockHash?.equals(BLOCK_HASH_OF_10496585));
            assert.isTrue(receipt?.blockNumber?.eq(BLOCK_NUMBER_OF_10496585));
          });

          it("returns null for non-existent transactions", async () => {
            const transaction = await client.getTransactionReceipt(
              randomHashBuffer()
            );
            assert.equal(transaction, null);
          });
        });

        describe("getLogs", () => {
          it("can fetch existing logs", async () => {
            const logs = await client.getLogs({
              fromBlock: BLOCK_NUMBER_OF_10496585,
              toBlock: BLOCK_NUMBER_OF_10496585,
              address: toBuffer("0x5acc84a3e955bdd76467d3348077d003f00ffb97"),
            });
            assert.equal(logs.length, 19);
          });
        });

        describe("getAccountData", () => {
          it("Should return the right data", async function () {
            const data = await client.getAccountData(DAI_ADDRESS, forkNumber);
            assert.equal(data.balance.toNumber(), 0);
            assert.equal(data.transactionCount.toNumber(), 1);
            assert.lengthOf(data.code, DAI_CONTRACT_LENGTH);
          });
        });
      });
    });
  });
});
