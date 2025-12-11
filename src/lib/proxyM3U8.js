import { Curl, CurlHttpVersion } from "node-libcurl";
import dotenv from "dotenv";

dotenv.config();

const host = process.env.HOST || "127.0.0.1";
const port = process.env.PORT || 8080;
const web_server_url = process.env.PUBLIC_URL || `http://${host}:${port}`;

function headerLinesToObject(headerStr) {
  const obj = {};
  for (const line of headerStr.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) {
      const k = line.slice(0, i).trim().toLowerCase();
      const v = line.slice(i + 1).trim();
      if (k) obj[k] = v;
    }
  }
  return obj;
}

function buildUpstreamHeaders(h = {}, uaFallback) {
  const ua =
    h["User-Agent"] ||
    h["user-agent"] ||
    uaFallback ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

  const referer = h["Referer"] || h["referer"] || "https://megaplay.buzz/";
  const origin  = h["Origin"]  || h["origin"]  || "https://animes.live";

  const arr = [
    `User-Agent: ${ua}`,
    `Referer: ${referer}`,
    `Origin: ${origin}`,
    // زوّدنا text/plain عشان بعض السيرفرات
    "Accept: application/vnd.apple.mpegurl, application/x-mpegURL, text/plain, */*",
    "Accept-Language: en-US,en;q=0.9,ar;q=0.8",
    "Accept-Encoding: gzip, deflate, br",
    "Cache-Control: no-cache",
    "Pragma: no-cache",
    "Connection: keep-alive",
    "Sec-Fetch-Site: cross-site",
    "Sec-Fetch-Mode: cors",
    "Sec-Fetch-Dest: video",
  ];

  // مرّر أي هيدر إضافي (ما عدا host/content-length)
  for (const [K, V] of Object.entries(h)) {
    if (V == null || V === "") continue;
    const kl = String(K).toLowerCase();
    if (kl === "host" || kl === "content-length") continue;
    if (!arr.some((x) => x.toLowerCase().startsWith(kl + ":"))) {
      arr.push(`${K}: ${V}`);
    }
  }
  return arr;
}

function extractCookieFromSetCookie(setCookieHeader) {
  if (!setCookieHeader) return "";
  const lines = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : String(setCookieHeader).split(/,(?=[^;]+?=)/);
  const pairs = [];
  for (const c of lines) {
    const m = String(c).trim().match(/^([^=;,\s]+)=([^;]+)/);
    if (m) pairs.push(`${m[1]}=${m[2]}`);
  }
  return pairs.length ? pairs.join("; ") : "";
}

function absURL(ref, baseURL) {
  try { return new URL(ref, baseURL).href; } catch { return ref; }
}

export default async function proxyM3U8(url, headers, res) {
  const curl = new Curl();
  const chunks = [];
  let headerRaw = "";

  try {
    const hlist = buildUpstreamHeaders(headers, res.getHeader?.("user-agent"));

    curl.setOpt(Curl.option.URL, url);
    curl.setOpt(Curl.option.HTTP_VERSION, CurlHttpVersion.V2TLS);
    curl.setOpt(Curl.option.FOLLOWLOCATION, true);
    curl.setOpt(Curl.option.MAXREDIRS, 5);
    curl.setOpt(Curl.option.HTTPHEADER, hlist);
    curl.setOpt(Curl.option.ACCEPT_ENCODING, "");
    curl.setOpt(Curl.option.SSL_VERIFYHOST, 2);
    curl.setOpt(Curl.option.SSL_VERIFYPEER, true);
    curl.setOpt(Curl.option.TIMEOUT, 15);
    curl.setOpt(Curl.option.CONNECTTIMEOUT, 5);

    curl.on("header", (buf) => {
      headerRaw += buf.toString("utf8");
      return buf.length;
    });

    curl.on("data", (buf) => {
      chunks.push(buf);
      return buf.length;
    });

    const code = await new Promise((resolve, reject) => {
      curl.on("end", (statusCode) => resolve(statusCode));
      curl.on("error", (e) => reject(e));
      curl.perform();
    });

    const body = Buffer.concat(chunks).toString("utf8");
    const hdrObj = headerLinesToObject(headerRaw);

    if (!(code >= 200 && code < 300)) {
      res.writeHead(code, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "*",
        "Content-Type": "text/plain; charset=utf-8",
      });
      res.end(`Upstream (${code})\n${body.slice(0, 1200)}`);
      return;
    }

    const cookieHeader = extractCookieFromSetCookie(hdrObj["set-cookie"]);
    const base = new URL(url);

    const lines = body.split(/\r?\n/);
    const out = [];

    const payloadHeaders = encodeURIComponent(
      JSON.stringify(
        {
          Referer: headers?.Referer || headers?.referer || "https://megaplay.buzz/",
          Origin:  headers?.Origin  || headers?.origin  || "https://megaplay.buzz",
          "User-Agent":
            headers?.["User-Agent"] ||
            headers?.["user-agent"] ||
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
          Cookie: cookieHeader || headers?.Cookie || headers?.cookie || undefined,
        }
      )
    );

    let nextIsVariant = false;

    for (const raw of lines) {
      const line = raw.trim();

      if (line === "" || line.startsWith("#")) {
        if (/^#EXT-X-STREAM-INF/i.test(line)) {
          out.push(raw);
          nextIsVariant = true;
          continue;
        }
        if (/^#EXT-X-KEY:/i.test(line)) {
          const m = raw.match(/URI="([^"]+)"/i);
          if (m && m[1]) {
            const abs = absURL(m[1], base);
            const prox =
              `${web_server_url}/ts-proxy?url=` +
              encodeURIComponent(abs) +
              `&headers=${payloadHeaders}`;
            out.push(raw.replace(m[1], prox));
          } else {
            out.push(raw);
          }
          continue;
        }
        if (/^#EXT-X-MEDIA:/i.test(line)) {
          const m = raw.match(/URI="([^"]+)"/i);
          if (m && m[1]) {
            const abs = absURL(m[1], base);
            const prox =
              `${web_server_url}/m3u8-proxy?url=` +
              encodeURIComponent(abs) +
              `&headers=${payloadHeaders}`;
            out.push(raw.replace(m[1], prox));
          } else {
            out.push(raw);
          }
          continue;
        }
        out.push(raw);
        continue;
      }

      const abs = absURL(line, base);
      const isPlaylist = abs.toLowerCase().includes(".m3u8");
      const prox =
        `${web_server_url}/${isPlaylist ? "m3u8-proxy" : "ts-proxy"}?url=` +
        encodeURIComponent(abs) +
        `&headers=${payloadHeaders}`;
      out.push(prox);
    }

    // إخراج
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "*");
    res.setHeader("Cache-Control", "no-cache");
    res.end(out.join("\n"));
  } catch (e) {
    res.writeHead(500, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "*",
      "Content-Type": "text/plain; charset=utf-8",
    });
    res.end(`Proxy error: ${e?.message || String(e)}`);
  } finally {
    try { curl.close(); } catch {}
  }
}
