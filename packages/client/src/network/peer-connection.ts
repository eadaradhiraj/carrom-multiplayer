// WebRTC peer connection wrapper — one instance per remote peer.
// Star topology (SPEC.md section 2): a non-host has exactly one of these
// (to the host); the host has one per non-host peer.
//
// Two data channels per connection, matching the reliability split in
// protocol.ts:
//   - "reliable"   : ordered, for ShotInput/ShotResolved/FullResync/etc.
//   - "unreliable" : unordered, maxRetransmits 0, for StateSnapshot.

import type { AnyMessage, ReliableMessage, UnreliableMessage } from "./protocol";
import type { SignalingClient } from "./signaling";

function getIceServers(): RTCIceServer[] {
  const defaults: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

  // Option 1: full JSON array via env — e.g. VITE_ICE_SERVERS='[{"urls":"stun:..."},{"urls":"turn:...","username":"u","credential":"p"}]'
  const envJson = (import.meta as any)?.env?.VITE_ICE_SERVERS as string | undefined;
  if (envJson) {
    try {
      const parsed = JSON.parse(envJson);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as RTCIceServer[];
    } catch {
      console.warn("[peer-connection] Failed to parse VITE_ICE_SERVERS JSON");
    }
  }

  // Option 2: discrete TURN env vars (for static or backend-injected short-lived credentials)
  const turnUrl = (import.meta as any)?.env?.VITE_TURN_URL as string | undefined;
  const turnUsername = (import.meta as any)?.env?.VITE_TURN_USERNAME as string | undefined;
  const turnCredential = (import.meta as any)?.env?.VITE_TURN_CREDENTIAL as string | undefined;

  if (turnUrl) {
    return [
      ...defaults,
      {
        urls: turnUrl,
        username: turnUsername,
        credential: turnCredential,
      },
    ];
  }

  return defaults;
}

const ICE_SERVERS: RTCIceServer[] = getIceServers();

export interface PeerConnectionHandlers {
  onReliableMessage: (msg: ReliableMessage) => void;
  onUnreliableMessage: (msg: UnreliableMessage) => void;
  onConnected: () => void;
  onDisconnected: () => void;
}

export class PeerConnection {
  private pc: RTCPeerConnection;
  private reliableChannel?: RTCDataChannel;
  private unreliableChannel?: RTCDataChannel;
  private pendingRemoteIce: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;

  constructor(
    private peerId: string,
    private isInitiator: boolean,
    private signaling: SignalingClient,
    private handlers: PeerConnectionHandlers,
  ) {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling.sendIceCandidate(this.peerId, event.candidate.toJSON());
      }
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      if (state === "connected") {
        this.handlers.onConnected();
      } else if (state === "disconnected" || state === "failed" || state === "closed") {
        // Used by RoomManager for both host-migration detection (SPEC.md
        // section 6) and non-host reconnect detection (section 7).
        this.handlers.onDisconnected();
      }
    };

    if (this.isInitiator) {
      this.createChannels();
      this.negotiate();
    } else {
      // Non-initiator receives channels created by the remote side.
      this.pc.ondatachannel = (event) => {
        this.attachChannel(event.channel);
      };
    }
  }

  private createChannels() {
    this.reliableChannel = this.pc.createDataChannel("reliable", { ordered: true });
    this.unreliableChannel = this.pc.createDataChannel("unreliable", {
      ordered: false,
      maxRetransmits: 0,
    });
    this.attachChannel(this.reliableChannel);
    this.attachChannel(this.unreliableChannel);
  }

  private attachChannel(channel: RTCDataChannel) {
    if (channel.label === "reliable") this.reliableChannel = channel;
    if (channel.label === "unreliable") this.unreliableChannel = channel;

    channel.onmessage = (event) => {
      const msg = JSON.parse(event.data) as AnyMessage;
      if (channel.label === "reliable") {
        this.handlers.onReliableMessage(msg as ReliableMessage);
      } else {
        this.handlers.onUnreliableMessage(msg as UnreliableMessage);
      }
    };
  }

  private async negotiate() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.signaling.sendOffer(this.peerId, offer);
  }

  /** Called by RoomManager when a signaling "offer" arrives from this peer. */
  async handleOffer(sdp: RTCSessionDescriptionInit) {
    await this.pc.setRemoteDescription(sdp);
    this.remoteDescriptionSet = true;
    await this.flushPendingIce();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.signaling.sendAnswer(this.peerId, answer);
  }

  /** Called by RoomManager when a signaling "answer" arrives from this peer. */
  async handleAnswer(sdp: RTCSessionDescriptionInit) {
    await this.pc.setRemoteDescription(sdp);
    this.remoteDescriptionSet = true;
    await this.flushPendingIce();
  }

  /** Called by RoomManager when a signaling "ice_candidate" arrives. */
  async handleIceCandidate(candidate: RTCIceCandidateInit) {
    if (this.remoteDescriptionSet) {
      await this.pc.addIceCandidate(candidate);
    } else {
      // ICE candidates can arrive before the offer/answer exchange
      // completes — buffer until we have a remote description.
      this.pendingRemoteIce.push(candidate);
    }
  }

  private async flushPendingIce() {
    for (const candidate of this.pendingRemoteIce) {
      await this.pc.addIceCandidate(candidate);
    }
    this.pendingRemoteIce = [];
  }

  sendReliable(msg: ReliableMessage) {
    if (this.reliableChannel?.readyState === "open") {
      this.reliableChannel.send(JSON.stringify(msg));
    }
  }

  sendUnreliable(msg: UnreliableMessage) {
    if (this.unreliableChannel?.readyState === "open") {
      this.unreliableChannel.send(JSON.stringify(msg));
    }
  }

  close() {
    this.reliableChannel?.close();
    this.unreliableChannel?.close();
    this.pc.close();
  }
}
