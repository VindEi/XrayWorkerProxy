# XrayWorkerProxy

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.style=for-the-badge)](https://opensource.org/licenses/MIT)
[![Protocol: XHTTP & WS](https://img.shields.io/badge/Protocols-XHTTP%20%7C%20WebSocket-green?style=for-the-badge)](https://github.com/XTLS/Xray-core)

A high-performance, zero-buffering Layer-7 (HTTP / WebSocket / XHTTP) Reverse Proxy engine built for the Cloudflare Workers V8 Isolate runtime.

This project enables edge-to-origin proxying for **Xray-core**, **3x-ui**, **Nginx**, and **Caddy** backends. It is specifically optimized for low-latency streaming and domain-blacklist evasion via SNI cloaking and edge header mutation.

---

## 📋 Table of Contents

- [Architecture & Blacklist Evasion Mechanics](#-architecture--blacklist-evasion-mechanics)
- [Supported Protocols & Transports](#-supported-protocols--transports)
- [Environment Variables & Secrets Setup](#-environment-variables--secrets-setup)
- [Step-by-Step Deployment Guide](#-step-by-step-deployment-guide)
- [VPS Inbound Configuration (XHTTP + TLS)](#-vps-inbound-configuration-xhttp--tls)
- [Client App Configuration Rules](#-client-app-configuration-rules)
- [Troubleshooting & Error Codes](#-troubleshooting--error-codes)
- [License](#-license)

---

## 🛡 Architecture & Blacklist Evasion Mechanics

### The Core Problem: DPI Domain Blacklisting

When connecting directly to a blacklisted domain (e.g., `your-blacklisted-domain.com`), Deep Packet Inspection (DPI) firewalls inspect the **TLS Client Hello** packet. Because SNI (Server Name Indication) is transmitted in plain text during the initial handshake, the DPI firewall matches `your-blacklisted-domain.com` against its blacklist and instantly drops the TCP connection before encryption is established.

```

[ Direct Connection Failure ]
Client ──( TLS Client Hello: SNI=your-blacklisted-domain.com )──► [ Local ISP / DPI Firewall ] ──► ❌ DROPPED (Blacklisted)

```

---

### The Solution: Worker-Based SNI Cloaking

By placing a Cloudflare Worker between the client and the VPS, the destination domain is hidden from local network inspection:

```

[ Worker Proxy Success Flow ]

[ Client Device ]
│
│ (1) TLS Handshake (SNI: myworker.workers.dev)
▼
┌──────────────────────────────────────────────────────────────────────┐
│ Local ISP / National Firewall │
│ - Inspects TLS Client Hello: SNI = myworker.workers.dev │
│ - Result: ALLOWED (Worker domain is not blacklisted) │
└──────────────────────────────────────────────────────────────────────┘
│
│ (2) Encrypted Stream to Cloudflare Edge (Outside Local Firewall)
▼
┌──────────────────────────────────────────────────────────────────────┐
│ Cloudflare Edge Engine (V8 Isolate) │
│ │
│ - Terminates incoming TLS session from client │
│ - Rewrites Host Header to: your-blacklisted-domain.com │
│ - Injects Client IP: X-Forwarded-For & X-Real-IP │
│ - Strips edge internal headers (cf-ray, cf-visitor) │
└──────────────────────────────────────────────────────────────────────┘
│
│ (3) Outbound fetch() over International Transit (duplex: "half")
▼
[ Origin VPS Backend ] ──► (Xray Inbound / 3x-ui / Nginx)

- Port: 443 / 8443 / 2087
- TLS Cert: your-blacklisted-domain.com

```

1. **Local ISP Visibility**: The ISP's DPI firewall **only sees** a connection to `myworker.workers.dev` (or a clean Cloudflare IP). The blacklisted domain `your-blacklisted-domain.com` is **never transmitted across the local national network**.
2. **Edge Execution**: Cloudflare receives the encrypted request outside the censored country, reads the target settings from Worker secrets, and opens a new connection to your VPS origin.
3. **Zero-Buffering Piping**: Request and response bodies are streamed using raw V8 `ReadableStream` instances with `duplex: "half"`, ensuring XHTTP chunked POST/GET streams maintain zero latency.

---

## ⚡ Supported Protocols & Transports

| Protocol Transport         | Compatibility Status | Notes / Implementation                                                               |
| :------------------------- | :------------------: | :----------------------------------------------------------------------------------- |
| **XHTTP (Split HTTP)**     |   🟢 Full Support    | Piped directly via `ReadableStream` pass-through without `.arrayBuffer()` buffering. |
| **WebSocket (WS)**         |   🟢 Full Support    | Automatic bi-directional socket upgrades for `HTTP 101 Switching Protocols`.         |
| **gRPC**                   |    🟡 Conditional    | Supported when `SCHEME="https"` with HTTP/2 enabled origin.                          |
| **VLESS / VMess / Trojan** |   🟢 Full Support    | Supported when encapsulated inside XHTTP or WebSocket transport layers.              |

---

## 🔒 Environment Variables & Secrets Setup

To prevent exposing your VPS IP or blacklisted domain on GitHub, do **not** hardcode values in `wrangler.toml`. Store them as Cloudflare Secrets.

| Secret Name   | Required Value Example                        | Purpose                                               |
| :------------ | :-------------------------------------------- | :---------------------------------------------------- |
| `TARGET_HOST` | `your-vps-domain.com` _(or VPS IP `1.2.3.4`)_ | Target backend host or IP for outbound edge requests. |
| `TARGET_PORT` | `443` _(or `8443`, `2087`)_                   | Listening port of the origin VPS inbound.             |
| `SCHEME`      | `https`                                       | Origin protocol (`https` recommended, or `http`).     |

---

## 🚀 Step-by-Step Deployment Guide

### Step 1: Clone Repository & Install Wrangler

```bash
git clone https://github.com/<YOUR_USERNAME>/XrayWorkerProxy.git
cd XrayWorkerProxy
npm install
```

### Step 2: Login & Deploy to Cloudflare

```bash
# Login to your Cloudflare account
npx wrangler login

# Deploy the Worker code
npx wrangler deploy
```

### Step 3: Set Secrets in Cloudflare

Add your private VPS origin parameters to Cloudflare securely:

```bash
# 1. Set backend domain or direct VPS IP
npx wrangler secret put TARGET_HOST
# Input: your-actual-vps-domain.com (or VPS IP)

# 2. Set backend inbound port
npx wrangler secret put TARGET_PORT
# Input: 443

# 3. Set outbound scheme
npx wrangler secret put SCHEME
# Input: https
```

---

## 🔌 VPS Inbound Configuration (XHTTP + TLS)

Apply this inbound structure to your **Xray-core** or **3x-ui** panel on your VPS:

```json
{
  "listen": "0.0.0.0",
  "port": 443,
  "protocol": "vless",
  "tag": "in-443-xhttp",
  "settings": {
    "clients": [],
    "decryption": "none"
  },
  "streamSettings": {
    "network": "xhttp",
    "security": "tls",
    "xhttpSettings": {
      "path": "/path?ed=443",
      "host": "your-vps-domain.com",
      "mode": "auto",
      "scMaxBufferedPosts": 30,
      "scStreamUpServerSecs": "20-80",
      "enableXmux": true,
      "xmux": {
        "maxConcurrency": "16",
        "hMaxRequestTimes": "600-900",
        "hMaxReusableSecs": "1800-3000"
      }
    },
    "tlsSettings": {
      "serverName": "your-vps-domain.com",
      "minVersion": "1.2",
      "maxVersion": "1.3",
      "certificates": [
        {
          "certificateFile": "/root/cert/your-vps-domain.com/fullchain.pem",
          "keyFile": "/root/cert/your-vps-domain.com/privkey.pem"
        }
      ],
      "alpn": ["h2", "http/1.1"]
    }
  }
}
```

---

## 📱 Client App Configuration Rules

In your client application (**v2rayNG**, **NekoBox**, **Sing-Box**, **Shadowrocket**), configure the connection parameters as follows:

```text
┌─────────────────────────────────────────────────────────────┐
│ Client Field       │ Value to Enter                         │
├────────────────────┼────────────────────────────────────────┤
│ Address / Server   │ myworker.workers.dev (or Clean CF IP)  │
│ Port               │ 443                                    │
│ Protocol           │ VLESS                                  │
│ Transport          │ xhttp                                  │
│ Path               │ /path?ed=443                           │
│ Host Header        │ myworker.workers.dev                   │
│ SNI / Server Name  │ myworker.workers.dev                   │
│ TLS                │ Enabled                                │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔍 Troubleshooting & Error Codes

### `HTTP 502 Bad Gateway`

- **Cause**: Worker cannot reach the VPS IP/Domain or the target port is blocked by the VPS firewall.
- **Fix**: Verify `TARGET_HOST` and `TARGET_PORT` match your VPS firewall and Xray inbound.

### `HTTP 403 Forbidden`

- **Cause**: Host header mismatch between the Worker outbound request and the Xray inbound TLS certificate.
- **Fix**: Ensure `TARGET_HOST` matches the domain configured in your VPS Xray TLS certificate.

---

## 📜 License

Distributed under the MIT License. See [`LICENSE`](./LICENSE) for details.
