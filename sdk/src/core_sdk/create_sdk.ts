import {
  RollupProviderStatusServerResponse,
  ServerRollupProvider,
  ServerRollupProviderExplorer,
} from 'barretenberg/rollup_provider';
import { EthereumBlockchain } from 'blockchain/ethereum_blockchain';
import { BroadcastChannel, createLeaderElection } from 'broadcast-channel';
import createDebug from 'debug';
import isNode from 'detect-node';
import { ethers } from 'ethers';
import { mkdirSync } from 'fs';
import levelup from 'levelup';
import { SrirachaProvider } from 'sriracha/hash_path_source';
import { DexieDatabase } from '../database';
import { EthereumProvider } from '../ethereum_provider';
import { SdkEvent, SdkInitState } from '../sdk';
import { CoreSdk, CoreSdkEvent, CoreSdkOptions } from './core_sdk';

const debug = createDebug('bb:create_sdk');

function getLevelDb() {
  if (isNode) {
    mkdirSync('./data', { recursive: true });
    // eslint-disable-next-line
    return levelup(require('leveldown')('./data/aztec2-sdk.db'));
  } else {
    // eslint-disable-next-line
    return levelup(require('level-js')('aztec2-sdk'));
  }
}

export type SdkOptions = {
  syncInstances?: boolean;
  clearDb?: boolean;
  debug?: boolean;
} & CoreSdkOptions;

async function sdkFactory(hostStr: string, options: SdkOptions, ethereumProvider?: EthereumProvider) {
  if (options.debug) {
    createDebug.enable('bb:*');
  }

  const host = new URL(hostStr);
  const leveldb = getLevelDb();

  if (options.clearDb) {
    await leveldb.clear();
    await DexieDatabase.clear();
  }

  const db = new DexieDatabase();

  if (!options.escapeHatchMode) {
    const rollupProvider = new ServerRollupProvider(host);
    const rollupProviderExplorer = new ServerRollupProviderExplorer(host);
    return new CoreSdk(leveldb, db, rollupProvider, rollupProviderExplorer, undefined, options);
  } else {
    if (!ethereumProvider) {
      throw new Error('Please provide an ethereum provider.');
    }
    const srirachaProvider = new SrirachaProvider(host);
    const provider = new ethers.providers.Web3Provider(ethereumProvider);
    const { rollupContractAddress } = await srirachaProvider.status();
    const config = { signer: provider.getSigner(0), networkOrHost: hostStr, console: false };
    const blockchain = await EthereumBlockchain.new(config, rollupContractAddress);
    return new CoreSdk(leveldb, db, blockchain, undefined, srirachaProvider, options);
  }
}

/**
 * Construct an SDK instance. If passed the `syncInstances` option, will bind a channel to various events to
 * share events and synchronise instances. Only one instance will be the "leader" and that instance will receive
 * blocks from the block source and update the (shared) world state.
 */
export async function createSdk(hostStr: string, options: SdkOptions = {}, ethereumProvider?: EthereumProvider) {
  options = { syncInstances: true, saveProvingKey: true, ...options };

  const sdk = await sdkFactory(hostStr, options, ethereumProvider);

  if (!options.syncInstances) {
    // We're not going to sync across multiple instances. We should start recieving blocks once initialized.
    sdk.on(SdkEvent.UPDATED_INIT_STATE, state => {
      if (state === SdkInitState.INITIALIZED) {
        sdk.startReceivingBlocks();
      }
    });
  } else {
    // We're going to sync across multiple instances.
    const channel = new BroadcastChannel('aztec-sdk');

    // If this instance becomes the leader at any time, and we are initialized, start recieving blocks.
    const elector = createLeaderElection(channel, { responseTime: 2000 });
    elector.awaitLeadership().then(() => {
      if (sdk.getLocalStatus().initState === SdkInitState.INITIALIZED) {
        sdk.startReceivingBlocks();
      } else {
        debug('elected leader, will wait until initialized to process blocks.');
      }
    });
    sdk.on(SdkEvent.UPDATED_INIT_STATE, state => {
      if (state === SdkInitState.INITIALIZED && elector.isLeader) {
        sdk.startReceivingBlocks();
      } else if (state === SdkInitState.DESTROYED) {
        channel.close();
      }
    });

    sdk.on(CoreSdkEvent.UPDATED_WORLD_STATE, () => channel.postMessage({ name: CoreSdkEvent.UPDATED_WORLD_STATE }));
    sdk.on(CoreSdkEvent.UPDATED_USERS, () => channel.postMessage({ name: CoreSdkEvent.UPDATED_USERS }));
    sdk.on(CoreSdkEvent.UPDATED_USER_STATE, (userId: Buffer) =>
      channel.postMessage({ name: CoreSdkEvent.UPDATED_USER_STATE, userId: userId.toString('hex') }),
    );
    sdk.on(CoreSdkEvent.CLEAR_DATA, () => channel.postMessage({ name: CoreSdkEvent.CLEAR_DATA }));

    channel.onmessage = msg => {
      if (sdk.getLocalStatus().initState !== SdkInitState.INITIALIZED) {
        return;
      }
      switch (msg.name) {
        case CoreSdkEvent.UPDATED_WORLD_STATE:
          sdk.notifyWorldStateUpdated();
          break;
        case CoreSdkEvent.UPDATED_USERS:
          sdk.initUserStates();
          break;
        case CoreSdkEvent.UPDATED_USER_STATE:
          sdk.notifyUserStateUpdated(Buffer.from(msg.userId, 'hex'));
          break;
        case CoreSdkEvent.CLEAR_DATA:
          sdk.notifiedClearData();
          break;
      }
    };
  }

  return sdk;
}