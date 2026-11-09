import { BlockList, isIP } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";
import { isTailnetAddress } from "../auth/clientAddress.js";

/* Issue #412: whether a device reaching this server over Tailscale is at
 * home or away from it, read off how this machine's tailscaled reaches it.
 *
 * `tailscale status --json` lists every peer with its tailnet addresses
 * (TailscaleIPs) and, while traffic flows directly, the endpoint it flows to
 * (CurAddr, "ip:port"). A device on the home network is reached at an
 * address on one of this machine's own networks; one away from home, at a
 * public address somewhere else.
 *
 * Never a guess. An empty CurAddr means the peer is idle, or relayed
 * through DERP (or a peer relay), and either way says nothing about where
 * it is: "unknown". So does a device that isn't in the list, this machine
 * itself, and anything that went wrong reading the status. */

export type Whereabouts = "home" | "away" | "unknown";

type PeerStatus = { TailscaleIPs?: string[] | null; CurAddr?: string | null };
type SelfStatus = { TailscaleIPs?: string[] | null; Addrs?: string[] | null };

/** The part of `tailscale status --json` this reads. */
export type TailscaleStatus = { Self?: SelfStatus | null; Peer?: Record<string, PeerStatus> | null };

/** One of this machine's own networks: an address and its prefix length. */
export type LocalNetwork = { address: string; prefix: number; family: "ipv4" | "ipv6" };

// Interfaces whose networks aren't the home network: Tailscale's own
// (tailscale0 on Linux, utun on a Mac, "Tailscale" on Windows), and the
// bridges Docker, libvirt and the like make for their guests. A peer's
// endpoint inside a container's bridge isn't a sign it's at home.
const NOT_HOME_INTERFACE = /^(tailscale|utun|docker|br-|veth|virbr|vmnet|vboxnet|cni|flannel|podman|lxcbr|lxdbr)/i;

/** This machine's own networks, from os.networkInterfaces(): every
 * interface's address and prefix, IPv6 included, less loopback, Tailscale's
 * own addresses and the container bridges above. */
export function localNetworks(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): LocalNetwork[] {
  const networks: LocalNetwork[] = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (NOT_HOME_INTERFACE.test(name)) continue;
    for (const info of addresses ?? []) {
      if (info.internal || isTailnetAddress(info.address)) continue;
      const prefix = Number(info.cidr?.split("/")[1]);
      if (!Number.isInteger(prefix)) continue;
      const family = String(info.family) === "IPv6" || String(info.family) === "6" ? "ipv6" : "ipv4";
      networks.push({ address: info.address.replace(/%.*$/, ""), prefix, family });
    }
  }
  return networks;
}

/** The address in an "ip:port" endpoint, "[v6]:port" included. Null for
 * anything that isn't one. */
export function endpointAddress(endpoint: string | null | undefined): string | null {
  if (!endpoint) return null;
  const bracketed = /^\[([^\]]+)\]:\d+$/.exec(endpoint);
  const host = bracketed ? bracketed[1]! : endpoint.replace(/:\d+$/, "");
  const plain = host.replace(/%.*$/, "").replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
  return isIP(plain) !== 0 ? plain : null;
}

/** Where the device at tailnet address `device` is, by `status` and this
 * machine's own `networks`. */
export function whereIs(status: TailscaleStatus | null, device: string | null, networks: readonly LocalNetwork[]): Whereabouts {
  if (!status || !device) return "unknown";
  const peer = Object.values(status.Peer ?? {}).find((p) => p.TailscaleIPs?.includes(device));
  if (!peer) return "unknown";
  const endpoint = endpointAddress(peer.CurAddr);
  if (!endpoint) return "unknown";
  const family = isIP(endpoint) === 4 ? "ipv4" : "ipv6";

  const home = new BlockList();
  for (const network of networks) {
    if (network.family === family) home.addSubnet(network.address, network.prefix, family);
  }
  if (home.check(endpoint, family)) return "home";

  // A device behind the same NAT as this machine can be reached at the
  // public address this machine has itself, on another port.
  const ownEndpoints = (status.Self?.Addrs ?? []).map(endpointAddress);
  if (ownEndpoints.includes(endpoint)) return "home";
  return "away";
}
