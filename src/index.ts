import {
  Client,
  Module,
  Args_tryResolveUri,
  Args_getFile,
  UriResolver_MaybeUriOrManifest,
  Bytes,
  Ethereum_Module,
  manifest,
} from "./wrap";

import { ethers } from "ethers";
import { PluginFactory } from "@polywrap/core-js";

export type Address = string;

export interface Addresses {
  [network: string]: Address;
}

export interface EnsContenthashResolverPluginConfig {
  addresses?: Addresses;
}

export class EnsContenthashResolverPlugin extends Module<EnsContenthashResolverPluginConfig> {
  public static defaultAddress = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";

  constructor(config?: EnsContenthashResolverPluginConfig) {
    super(config ?? {});

    // Sanitize address
    if (this.config.addresses) {
      this._setAddresses(this.config.addresses);
    }
  }

  async tryResolveUri(
    args: Args_tryResolveUri,
    client: Client
  ): Promise<UriResolver_MaybeUriOrManifest | null> {
    if (args.authority !== "ens") {
      return null;
    }

    try {
      const contenthash = await this.ensToContenthash(args.path, client);

      if (!contenthash) {
        return null;
      }

      return {
        uri: `ens-contenthash/${contenthash}`,
        manifest: null,
      };
    } catch (e) {
      return { uri: null, manifest: null };
    }
  }

  getFile(_args: Args_getFile, _client: Client): Bytes | null {
    return null;
  }

  async ensToContenthash(domain: string, client: Client): Promise<string> {
    const ensAbi = {
      resolver:
        "function resolver(bytes32 node) external view returns (address)",
    };
    const resolverAbi = {
      contenthash:
        "function contenthash(bytes32 nodehash) view returns (bytes)",
      content: "function content(bytes32 nodehash) view returns (bytes32)",
    };

    let ensAddress = EnsContenthashResolverPlugin.defaultAddress;

    // Remove the ENS URI scheme & authority
    domain = domain.replace("wrap://", "");
    domain = domain.replace("ens/", "");

    // Check for non-default network
    let network = "mainnet";
    const hasNetwork = /^[A-Za-z0-9]+\//i.exec(domain);
    if (hasNetwork) {
      network = domain.substring(0, domain.indexOf("/"));

      // Remove the network from the domain URI's path
      domain = domain.replace(network + "/", "");

      // Lowercase only
      network = network.toLowerCase();

      // Check if we have a custom address configured
      // for this network
      if (this.config.addresses && this.config.addresses[network]) {
        ensAddress = this.config.addresses[network];
      }
    }

    const domainNode = ethers.utils.namehash(domain);

    const callContractView = async (
      address: string,
      method: string,
      args: string[],
      networkNameOrChainId?: string
    ): Promise<string> => {
      const { data, error } = await Ethereum_Module.callContractView(
        {
          address,
          method,
          args,
          connection: networkNameOrChainId
            ? {
                networkNameOrChainId,
              }
            : undefined,
        },
        client
      );

      if (error) {
        throw error;
      }

      if (data) {
        if (typeof data !== "string") {
          throw Error(
            `Malformed data returned from Ethereum.callContractView: ${data}`
          );
        }

        return data;
      }

      throw Error(
        `Ethereum.callContractView returned nothing.\nData: ${data}\nError: ${error}`
      );
    };

    // Get the node's resolver address
    const resolverAddress = await callContractView(
      ensAddress,
      ensAbi.resolver,
      [domainNode],
      network
    );

    // Get the CID stored at this domain
    let hash;
    try {
      hash = await callContractView(
        resolverAddress,
        resolverAbi.contenthash,
        [domainNode],
        network
      );
    } catch (e) {
      try {
        // Fallback, contenthash doesn't exist, try content
        hash = await callContractView(
          resolverAddress,
          resolverAbi.content,
          [domainNode],
          network
        );
      } catch (err) {
        // The resolver contract is unknown...
        throw Error(`Incompatible resolver ABI at address ${resolverAddress}`);
      }
    }

    if (hash === "0x") {
      return "";
    }

    return hash;
  }

  private _setAddresses(addresses: Addresses): void {
    this.config.addresses = {};

    for (const network of Object.keys(addresses)) {
      this.config.addresses[network] = addresses[network];
    }
  }
}

export const ensContenthashResolverPlugin: PluginFactory<EnsContenthashResolverPluginConfig> = (
  config?: EnsContenthashResolverPluginConfig
) => {
  return {
    factory: () => new EnsContenthashResolverPlugin(config),
    manifest,
  };
};

export const plugin = ensContenthashResolverPlugin;
