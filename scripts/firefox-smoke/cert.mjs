/**
 * A throwaway self-signed TLS certificate, built in memory with node:crypto.
 *
 * Node can generate keys and sign bytes but has no API to *build* an X.509
 * certificate, so the few DER structures a certificate needs are encoded by
 * hand below (about 60 lines, no dependency, no openssl binary). The key never
 * touches the disk: it lives in this process for the length of one run.
 *
 * Firefox is launched with acceptInsecureCerts, so it would accept almost any
 * certificate. The names are still right (SAN = every host the harness
 * answers for) so that the certificate is also usable for a manual session
 * with a one-off exception.
 */
import crypto from "node:crypto";

/* ------------------------------------------------------------ DER basics -- */

function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, ...content) {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const seq = (...c) => tlv(0x30, ...c);
const set = (...c) => tlv(0x31, ...c);
const explicit = (n, ...c) => tlv(0xa0 | n, ...c);
const octets = (buf) => tlv(0x04, buf);
const utf8 = (s) => tlv(0x0c, Buffer.from(s, "utf8"));
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));

function oid(dotted) {
  const arcs = dotted.split(".").map(Number);
  const out = [40 * arcs[0] + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const chunk = [];
    let v = arc;
    do {
      chunk.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    } while (v > 0);
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80;
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

function integer(buf) {
  // DER integers are signed: keep the serial positive.
  const b = buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf;
  return tlv(0x02, b);
}

function utcTime(date) {
  const p = (n) => String(n).padStart(2, "0");
  const s =
    p(date.getUTCFullYear() % 100) +
    p(date.getUTCMonth() + 1) +
    p(date.getUTCDate()) +
    p(date.getUTCHours()) +
    p(date.getUTCMinutes()) +
    p(date.getUTCSeconds()) +
    "Z";
  return tlv(0x17, Buffer.from(s, "ascii"));
}

function ipv4(ip) {
  return Buffer.from(ip.split(".").map(Number));
}

/* ----------------------------------------------------------- certificate -- */

const OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2";
const OID_CN = "2.5.4.3";
const OID_SAN = "2.5.29.17";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_EXT_KEY_USAGE = "2.5.29.37";
const OID_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";

/**
 * @param {string[]} dnsNames names for the subjectAltName (wildcards allowed)
 * @returns {{ key: string, cert: string, fingerprint256: string }} PEM strings
 */
export function makeSelfSignedCert(dnsNames) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const algorithm = seq(oid(OID_ECDSA_SHA256));
  const name = seq(set(seq(oid(OID_CN), utf8("Cuter Intra smoke test (throwaway)"))));

  const now = Date.now();
  const notBefore = new Date(now - 24 * 3600 * 1000);
  const notAfter = new Date(now + 7 * 24 * 3600 * 1000);

  const san = seq(
    ...dnsNames.map((n) => tlv(0x82, Buffer.from(n, "ascii"))),
    tlv(0x87, ipv4("127.0.0.1")),
  );
  const extensions = explicit(
    3,
    seq(
      seq(oid(OID_BASIC_CONSTRAINTS), bool(true), octets(seq())),
      seq(oid(OID_EXT_KEY_USAGE), octets(seq(oid(OID_SERVER_AUTH)))),
      seq(oid(OID_SAN), octets(san)),
    ),
  );

  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))), // v3
    integer(serial),
    algorithm,
    name, // issuer
    seq(utcTime(notBefore), utcTime(notAfter)),
    name, // subject
    spki,
    extensions,
  );
  const signature = crypto.sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" });
  const der = seq(tbs, algorithm, tlv(0x03, Buffer.from([0]), signature));

  const b64 = der.toString("base64").match(/.{1,64}/g).join("\n");
  const cert = `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
  const key = privateKey.export({ type: "pkcs8", format: "pem" });

  // Parse it back: a malformed encoding fails here, not as a TLS error later.
  const x509 = new crypto.X509Certificate(cert);
  if (!x509.verify(publicKey)) throw new Error("self-signed certificate does not verify");
  return { key, cert, fingerprint256: x509.fingerprint256 };
}
