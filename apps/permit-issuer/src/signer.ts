import { getAddress, verifyTypedData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  registrationPermitDomain,
  registrationPermitTypes,
  type RegistrationPermit,
} from "@contour/sdk";

export interface PermitSigner {
  sign(permit: RegistrationPermit): Promise<Hex>;
  health(): Promise<{ signerAddress: Address; signerKind: "local-private-key" }>;
}

/**
 * Signs Arc Testnet registration permits with the canonical governance EOA's
 * server-only secret. Release 1 intentionally uses that same EOA for protocol
 * ownership, treasury settlement and permit signing.
 *
 * The raw key is converted to a viem account during construction and is never
 * logged or returned. Every resulting signature is recovered locally against
 * the signer address pinned by the active deployment manifest.
 */
export class LocalPrivateKeySigner implements PermitSigner {
  private readonly account: ReturnType<typeof privateKeyToAccount>;
  readonly expectedAddress: Address;

  constructor(privateKey: Hex, expectedAddress: Address) {
    this.account = privateKeyToAccount(privateKey);
    this.expectedAddress = getAddress(expectedAddress);
    if (getAddress(this.account.address) !== this.expectedAddress) {
      throw new Error("registration permit signer key does not match the manifest signer address");
    }
  }

  async health() {
    return {
      signerAddress: getAddress(this.account.address),
      signerKind: "local-private-key" as const,
    };
  }

  async sign(permit: RegistrationPermit): Promise<Hex> {
    const signature = await this.account.signTypedData({
      domain: registrationPermitDomain(permit.controller),
      types: registrationPermitTypes,
      primaryType: "RegistrationPermit",
      message: permit,
    });
    const valid = await verifyTypedData({
      address: this.expectedAddress,
      domain: registrationPermitDomain(permit.controller),
      types: registrationPermitTypes,
      primaryType: "RegistrationPermit",
      message: permit,
      signature,
    });
    if (!valid) throw new Error("local signer produced an invalid EIP-712 signature");
    return signature;
  }
}
