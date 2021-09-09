import { EthAddress } from '@aztec/barretenberg/address';
import { AssetId } from '@aztec/barretenberg/asset';
import { Asset } from '@aztec/barretenberg/blockchain';
import { BridgeId } from '@aztec/barretenberg/bridge_id';
import { DefiInteractionNote, packInteractionNotes } from '@aztec/barretenberg/note_algorithms';
import { InnerProofData, RollupProofData } from '@aztec/barretenberg/rollup_proof';
import { ViewingKey } from '@aztec/barretenberg/viewing_key';
import { WorldStateConstants } from '@aztec/barretenberg/world_state';
import { Contract } from '@ethersproject/contracts';
import { randomBytes } from 'crypto';
import { Signer } from 'ethers';
import { ethers } from 'hardhat';
import { EthersAdapter } from '../../provider';
import { Web3Signer } from '../../signer';
import { FeeDistributor } from '../fee_distributor';
import { advanceBlocks, blocksToAdvance } from './fixtures/advance_block';
import {
  createAccountProof,
  createDefiClaimProof,
  createDefiDepositProof,
  createDepositProof,
  createRollupProof,
  createSendProof,
  createWithdrawProof,
  DefiInteractionData,
  mergeInnerProofs,
} from './fixtures/create_mock_proof';
import { deployMockDefiBridge } from './fixtures/setup_defi_bridges';
import { setupRollupProcessor } from './fixtures/setup_rollup_processor';
import { RollupProcessor } from './rollup_processor';

describe('rollup_processor', () => {
  const ethereumProvider = new EthersAdapter(ethers.provider);
  let feeDistributor: FeeDistributor;
  let rollupProcessor: RollupProcessor;
  let signers: Signer[];
  let addresses: EthAddress[];
  let assets: Asset[];

  beforeEach(async () => {
    signers = await ethers.getSigners();
    addresses = await Promise.all(signers.map(async u => EthAddress.fromString(await u.getAddress())));
    ({ rollupProcessor, feeDistributor, assets } = await setupRollupProcessor(signers, 1));
  });

  it('should get contract status', async () => {
    expect(rollupProcessor.address).toEqual(rollupProcessor.address);
    expect(await rollupProcessor.feeDistributor()).toEqual(feeDistributor.address);
    expect(await rollupProcessor.numberOfAssets()).toBe(16);
    expect(await rollupProcessor.numberOfBridgeCalls()).toBe(4);
    expect(await rollupProcessor.nextRollupId()).toBe(0);
    expect(await rollupProcessor.dataSize()).toBe(0);
    expect(await rollupProcessor.dataRoot()).toEqual(WorldStateConstants.EMPTY_DATA_ROOT);
    expect(await rollupProcessor.nullRoot()).toEqual(WorldStateConstants.EMPTY_NULL_ROOT);
    expect(await rollupProcessor.rootRoot()).toEqual(WorldStateConstants.EMPTY_ROOT_ROOT);
    expect(await rollupProcessor.defiRoot()).toEqual(WorldStateConstants.EMPTY_DEFI_ROOT);
    expect(await rollupProcessor.defiInteractionHash()).toEqual(WorldStateConstants.INITIAL_INTERACTION_HASH);
    expect(await rollupProcessor.totalDeposited()).toEqual([0n, 0n]);
    expect(await rollupProcessor.totalWithdrawn()).toEqual([0n, 0n]);
    expect(await rollupProcessor.totalFees()).toEqual([0n, 0n]);
    expect(await rollupProcessor.totalPendingDeposit()).toEqual([0n, 0n]);
    expect(await rollupProcessor.getSupportedAssets()).toEqual(assets.map(a => a.getStaticInfo().address));
    expect(await rollupProcessor.getEscapeHatchStatus()).toEqual({ escapeOpen: true, blocksRemaining: 20 });
  });

  it('should get supported asset', async () => {
    const supportedAssetAAddress = await rollupProcessor.getSupportedAsset(1);
    expect(supportedAssetAAddress).toEqual(assets[1].getStaticInfo().address);
  });

  it('should set new supported asset', async () => {
    const assetAddr = EthAddress.randomAddress();
    const txHash = await rollupProcessor.setSupportedAsset(assetAddr, false);

    // Check event was emitted.
    const receipt = await ethers.provider.getTransactionReceipt(txHash.toString());
    const assetBId = rollupProcessor.contract.interface.parseLog(receipt.logs[receipt.logs.length - 1]).args.assetId;
    const assetBAddress = rollupProcessor.contract.interface.parseLog(receipt.logs[receipt.logs.length - 1]).args
      .assetAddress;
    expect(assetBId.toNumber()).toBe(2);
    expect(assetBAddress).toBe(assetAddr.toString());

    const supportedAssetBAddress = await rollupProcessor.getSupportedAsset(2);
    expect(supportedAssetBAddress).toEqual(assetAddr);
  });

  it('should approve a proof', async () => {
    const proofHash = randomBytes(32);
    expect(await rollupProcessor.getProofApprovalStatus(addresses[0], proofHash)).toBe(false);
    expect(await rollupProcessor.getProofApprovalStatus(addresses[1], proofHash)).toBe(false);
    await rollupProcessor.approveProof(proofHash, { signingAddress: addresses[1] });
    expect(await rollupProcessor.getProofApprovalStatus(addresses[0], proofHash)).toBe(false);
    expect(await rollupProcessor.getProofApprovalStatus(addresses[1], proofHash)).toBe(true);
  });

  it('should return whether an asset supports the permit ERC-2612 approval flow', async () => {
    expect(await rollupProcessor.getAssetPermitSupport(AssetId.ETH)).toBe(false);
    expect(await rollupProcessor.getAssetPermitSupport(AssetId.DAI)).toBe(true);
  });

  it('should allow any address to use escape hatch', async () => {
    const { proofData } = await createRollupProof(signers[0], createSendProof());
    const tx = await rollupProcessor.createEscapeHatchProofTx(proofData, [], []);
    await rollupProcessor.sendTx(tx);
  });

  it('should reject a rollup from an unknown provider', async () => {
    const { proofData, signatures, providerSignature, viewingKeys } = await createRollupProof(
      signers[0],
      createSendProof(),
      { feeDistributorAddress: feeDistributor.address },
    );
    const tx = await rollupProcessor.createRollupProofTx(
      proofData,
      signatures,
      viewingKeys,
      providerSignature,
      addresses[1],
      addresses[0],
    );
    await expect(rollupProcessor.sendTx(tx)).rejects.toThrow('UNKNOWN_PROVIDER');
  });

  it('should reject a rollup with a bad provider signature', async () => {
    const { proofData, signatures, viewingKeys, sigData } = await createRollupProof(signers[0], createSendProof(), {
      feeDistributorAddress: feeDistributor.address,
    });

    const providerSignature = await new Web3Signer(ethereumProvider).signMessage(sigData, addresses[1]);

    const tx = await rollupProcessor.createRollupProofTx(
      proofData,
      signatures,
      viewingKeys,
      providerSignature,
      addresses[0],
      addresses[0],
    );
    await expect(rollupProcessor.sendTx(tx)).rejects.toThrow('validateSignature: INVALID_SIGNATURE');
  });

  it('should allow the owner to change the verifier address', async () => {
    await rollupProcessor.setVerifier(EthAddress.randomAddress());
  });

  it('should not be able to set the verifier if not the owner', async () => {
    await expect(
      rollupProcessor.setVerifier(EthAddress.randomAddress(), { signingAddress: addresses[1] }),
    ).rejects.toThrow('Ownable: caller is not the owner');
  });

  it('should get escape hatch open status', async () => {
    const nextEscapeBlock = await blocksToAdvance(80, 100, ethers.provider);
    await advanceBlocks(nextEscapeBlock, ethers.provider);

    const { escapeOpen, blocksRemaining } = await rollupProcessor.getEscapeHatchStatus();
    expect(escapeOpen).toBe(true);
    expect(blocksRemaining).toBe(20);
  });

  it('should get escape hatch closed status', async () => {
    const nextEscapeBlock = await blocksToAdvance(79, 100, ethers.provider);
    await advanceBlocks(nextEscapeBlock, ethers.provider);

    const { escapeOpen, blocksRemaining } = await rollupProcessor.getEscapeHatchStatus();
    expect(escapeOpen).toBe(false);
    expect(blocksRemaining).toBe(1);
  });

  it('should reject escape hatch outside valid block window', async () => {
    const { proofData, viewingKeys } = await createRollupProof(signers[1], createSendProof());
    const escapeBlock = await blocksToAdvance(0, 100, ethers.provider);
    await advanceBlocks(escapeBlock, ethers.provider);
    const tx = await rollupProcessor.createEscapeHatchProofTx(proofData, viewingKeys, []);
    await expect(rollupProcessor.sendTx(tx, { signingAddress: addresses[1] })).rejects.toThrow(
      'Rollup Processor: ESCAPE_BLOCK_RANGE_INCORRECT',
    );
  });

  it('should process all proof types and get specified blocks', async () => {
    const inputAssetId = AssetId.DAI;
    const bridge = await deployMockDefiBridge(
      signers[0],
      1,
      assets[AssetId.DAI].getStaticInfo().address,
      EthAddress.ZERO,
      EthAddress.ZERO,
      0n,
      2n,
      0n,
      true,
      10n,
    );
    const bridgeId = new BridgeId(EthAddress.fromString(bridge.address), 1, AssetId.DAI, AssetId.ETH, 0);
    const numberOfBridgeCalls = RollupProofData.NUM_BRIDGE_CALLS_PER_BLOCK;

    const userAAddress = addresses[1];
    const userA = signers[1];

    const depositAmount = 30n;
    const sendAmount = 6n;
    const defiDepositAmount0 = 12n;
    const defiDepositAmount1 = 8n;
    const withdrawalAmount = 10n;

    const innerProofOutputs = [
      await createDepositProof(depositAmount, userAAddress, userA, inputAssetId),
      mergeInnerProofs([createAccountProof(), createSendProof(inputAssetId, sendAmount)]),
      mergeInnerProofs([
        createDefiDepositProof(bridgeId, defiDepositAmount0),
        createDefiDepositProof(bridgeId, defiDepositAmount1),
      ]),
      createWithdrawProof(withdrawalAmount, userAAddress, inputAssetId),
      createDefiClaimProof(bridgeId),
    ];

    const expectedInteractionResult = [
      new DefiInteractionNote(bridgeId, numberOfBridgeCalls * 2, 12n, 2n, 0n, true),
      new DefiInteractionNote(bridgeId, numberOfBridgeCalls * 2 + 1, 8n, 2n, 0n, true),
    ];
    const previousDefiInteractionHash = packInteractionNotes(expectedInteractionResult, numberOfBridgeCalls);

    // Deposit to contract.
    await assets[inputAssetId].approve(depositAmount, userAAddress, rollupProcessor.address);
    await rollupProcessor.depositPendingFunds(inputAssetId, depositAmount, undefined, {
      signingAddress: userAAddress,
    });

    for (let i = 0; i < innerProofOutputs.length; ++i) {
      const { proofData, viewingKeys, signatures } = await createRollupProof(signers[0], innerProofOutputs[i], {
        rollupId: i,
        defiInteractionData:
          i === 2
            ? [
                new DefiInteractionData(bridgeId, defiDepositAmount0),
                new DefiInteractionData(bridgeId, defiDepositAmount1),
              ]
            : [],
        previousDefiInteractionHash: i === 3 ? previousDefiInteractionHash : undefined,
      });
      const tx = await rollupProcessor.createEscapeHatchProofTx(proofData, viewingKeys, signatures);
      await rollupProcessor.sendTx(tx);
    }

    const blocks = await rollupProcessor.getRollupBlocksFrom(0, 1);
    expect(blocks.length).toBe(5);

    const emptyViewingKeys = [ViewingKey.EMPTY, ViewingKey.EMPTY];

    {
      const block = blocks[0];
      const rollup = RollupProofData.fromBuffer(block.rollupProofData, block.viewingKeysData);
      const { innerProofs, viewingKeys } = innerProofOutputs[0];
      expect(block).toMatchObject({
        rollupId: 0,
        rollupSize: 2,
        interactionResult: [],
      });
      expect(rollup).toMatchObject({
        rollupId: 0,
        dataStartIndex: 0,
        innerProofData: [innerProofs[0], InnerProofData.PADDING],
        viewingKeys: [viewingKeys, emptyViewingKeys],
      });
    }

    {
      const block = blocks[1];
      const rollup = RollupProofData.fromBuffer(block.rollupProofData, block.viewingKeysData);
      const { innerProofs, viewingKeys } = innerProofOutputs[1];
      expect(block).toMatchObject({
        rollupId: 1,
        rollupSize: 2,
        interactionResult: [],
      });
      expect(rollup).toMatchObject({
        rollupId: 1,
        dataStartIndex: 4,
        innerProofData: innerProofs,
        viewingKeys: [emptyViewingKeys, viewingKeys],
      });
    }

    {
      const block = blocks[2];
      const rollup = RollupProofData.fromBuffer(block.rollupProofData, block.viewingKeysData);
      const { innerProofs, viewingKeys } = innerProofOutputs[2];
      expect(block).toMatchObject({
        rollupId: 2,
        rollupSize: 2,
        interactionResult: expectedInteractionResult,
      });
      expect(rollup).toMatchObject({
        rollupId: 2,
        dataStartIndex: 8,
        innerProofData: innerProofs,
        viewingKeys: [viewingKeys.slice(0, 2), viewingKeys.slice(2)],
      });
    }

    {
      const block = blocks[3];
      const rollup = RollupProofData.fromBuffer(block.rollupProofData, block.viewingKeysData);
      const { innerProofs, viewingKeys } = innerProofOutputs[3];
      expect(block).toMatchObject({
        rollupId: 3,
        rollupSize: 2,
        interactionResult: [],
      });
      expect(rollup).toMatchObject({
        rollupId: 3,
        dataStartIndex: 12,
        innerProofData: [innerProofs[0], InnerProofData.PADDING],
        viewingKeys: [viewingKeys, emptyViewingKeys],
      });
    }

    {
      const block = blocks[4];
      const rollup = RollupProofData.fromBuffer(block.rollupProofData, block.viewingKeysData);
      const { innerProofs } = innerProofOutputs[4];
      expect(block).toMatchObject({
        rollupId: 4,
        rollupSize: 2,
        interactionResult: [],
      });
      expect(rollup).toMatchObject({
        rollupId: 4,
        dataStartIndex: 16,
        innerProofData: [innerProofs[0], InnerProofData.PADDING],
        viewingKeys: [emptyViewingKeys, emptyViewingKeys],
      });
    }
  });
});