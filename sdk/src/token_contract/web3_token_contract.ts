import { Contract } from 'ethers';
import { Web3Provider } from '@ethersproject/providers';
import { EthAddress } from 'barretenberg/address';
import { ContractTransaction } from '@ethersproject/contracts';
import { parseUnits, formatUnits } from '@ethersproject/units';
import { TokenContract } from '.';

const minimalERC20ABI = [
  'function decimals() public view returns (uint8)',
  'function approve(address spender, uint256 amount) public returns (bool)',
  'function allowance(address owner, address spender) public view returns (uint256)',
  'function balanceOf(address account) public view returns (uint256)',
  'function mint(address _to, uint256 _value) public returns (bool)',
];

export class Web3TokenContract implements TokenContract {
  private contract!: Contract;
  private decimals = 0;
  private confirmations = 2;

  constructor(
    private ethersProvider: Web3Provider,
    private contractAddress: EthAddress,
    private rollupContractAddress: EthAddress,
    private chainId: number,
  ) {
    this.contract = new Contract(contractAddress.toString(), minimalERC20ABI, ethersProvider);
  }

  async init() {
    // If ganache, just 1 confirmation.
    const { chainId } = await this.ethersProvider.getNetwork();
    if (chainId === 1337) {
      this.confirmations = 1;
    }

    const decimals = await this.contract.decimals();
    this.decimals = +decimals;
  }

  getDecimals() {
    return this.decimals;
  }

  getAddress() {
    return this.contractAddress;
  }

  async balanceOf(account: EthAddress) {
    await this.checkProviderChain();
    const balance = await this.contract.balanceOf(account.toString());
    return BigInt(balance);
  }

  async allowance(owner: EthAddress) {
    await this.checkProviderChain();
    const allowance = await this.contract.allowance(owner.toString(), this.rollupContractAddress.toString());
    return BigInt(allowance);
  }

  async approve(account: EthAddress, value: bigint) {
    await this.checkProviderChain();
    const contract = new Contract(
      this.contractAddress.toString(),
      minimalERC20ABI,
      this.ethersProvider.getSigner(account.toString()),
    );
    const res = (await contract.approve(this.rollupContractAddress.toString(), value)) as ContractTransaction;
    const receipt = await res.wait(this.confirmations);
    return Buffer.from(receipt.transactionHash.slice(2), 'hex');
  }

  async mint(account: EthAddress, value: bigint) {
    await this.checkProviderChain();
    const contract = new Contract(
      this.contractAddress.toString(),
      minimalERC20ABI,
      this.ethersProvider.getSigner(account.toString()),
    );
    const res = await contract.mint(account.toString(), value);
    const receipt = await res.wait(this.confirmations);
    return Buffer.from(receipt.transactionHash.slice(2), 'hex');
  }

  private async checkProviderChain() {
    const { chainId } = await this.ethersProvider.getNetwork();
    if (this.chainId != chainId) {
      throw new Error(`Set provider to correct network: ${chainId}`);
    }
  }

  public fromErc20Units(value: bigint) {
    const decimals = this.getDecimals();
    return formatUnits(value.toString(), decimals);
  }

  public toErc20Units(value: string) {
    const decimals = this.getDecimals();
    return BigInt(parseUnits(value, decimals).toString());
  }
}