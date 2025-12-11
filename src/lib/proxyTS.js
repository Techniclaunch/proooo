import { Curl, CurlHttpVersion } from "node-libcurl";

function buildUpstreamHeaders(h = {}, clientRange) {
  const ua =
    h["User-Agent"] ||
    h["user-agent"] ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

  const referer = h["Referer"] || h["referer"] || "https://megaplay.buzz/";
  const origin  = h["Origin"]  || h["origin"]  || "https://animes.live";

  const arr = [
    `User-Agent: ${ua}`,
    `Referer: ${referer}`,
    `Origin: ${origin}`,
    "Accept: */*", // مرّر أي نوع (ts/jpg/vtt…)
    "Accept-Language: en-US,en;q=0.9,ar;q=0.8",
    "Accept-Encoding: gzip, deflate, br",
    "Connection: keep-alive",
  ];

  if (h.Cookie || h.cookie) arr.push(`Cookie: ${h.Cookie || h.cookie}`);
  if (clientRange)         arr.push(`Range: ${clientRange}`);

  // مرّر أي إضافات غير حساسة
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

export async function proxyTs(url, headers, req, res) {
  const curl = new Curl();

  // نجمع الهيدرز من الـ upstream ونرسلها مرّة واحدة قبل أول بايت body
  let statusCode = 200;
  const outHeaders = Object.create(null);
  let headersSent = false;

  try {
    const clientRange = req.headers["range"] || req.headers["Range"];
    const hlist = buildUpstreamHeaders(headers, clientRange);

    curl.setOpt(Curl.option.URL, url);
    curl.setOpt(Curl.option.HTTP_VERSION, CurlHttpVersion.V2TLS);
    curl.setOpt(Curl.option.FOLLOWLOCATION, true);
    curl.setOpt(Curl.option.MAXREDIRS, 5);
    curl.setOpt(Curl.option.HTTPHEADER, hlist);
    curl.setOpt(Curl.option.ACCEPT_ENCODING, "");
    curl.setOpt(Curl.option.SSL_VERIFYHOST, 2);
    curl.setOpt(Curl.option.SSL_VERIFYPEER, true);
    curl.setOpt(Curl.option.TIMEOUT, 30);
    curl.setOpt(Curl.option.CONNECTTIMEOUT, 5);
    curl.setOpt(Curl.option.NOBODY, req.method === "HEAD");

    // اجمع الهيدرز
    curl.on("header", (buf) => {
      const line = buf.toString("utf8").trim();
      if (!line) return buf.length;

      // سطر الحالة HTTP/1.1 206 ...
      const m = line.match(/^HTTP\/\d\.\d\s+(\d+)/i);
      if (m) {
        statusCode = parseInt(m[1], 10) || 200;
        return buf.length;
      }

      const idx = line.indexOf(":");
      if (idx > 0) {
        const kRaw = line.slice(0, idx).trim();
        const vRaw = line.slice(idx + 1).trim();
        const k = kRaw.toLowerCase();

        // مرّر الهيدرز المفيدة، واترك الباقي
        const pass = new Set([
          "content-type",
          "content-length",
          "accept-ranges",
          "content-range",
          "etag",
          "last-modified",
          "cache-control",
          "date",
          "server",
        ]);

        if (pass.has(k)) {
          // لا تعيّن مرتين
          if (outHeaders[kRaw] === undefined) outHeaders[kRaw] = vRaw;
        }
      }
      return buf.length;
    });

    // اكتب الـbody بعد ما نرسل الهيدرز أولًا
    curl.on("data", (chunk) => {
      if (!headersSent) {
        // أضف CORS قبل الإرسال
        outHeaders["Access-Control-Allow-Origin"]  = "*";
        outHeaders["Access-Control-Allow-Headers"] = "*";
        outHeaders["Access-Control-Allow-Methods"] = "*";

        // تأكد من وجود content-type كـ fallback
        if (
          !Object.keys(outHeaders).some(
            (k) => k.toLowerCase() === "content-type"
          )
        ) {
          outHeaders["Content-Type"] = "application/octet-stream";
        }

        res.writeHead(statusCode || 200, outHeaders);
        headersSent = true;
      }
      res.write(chunk);
      return chunk.length;
    });

    await new Promise((resolve, reject) => {
      curl.on("end", () => {
        if (!headersSent) {
          // في حالة HEAD أو رد بدون body
          outHeaders["Access-Control-Allow-Origin"]  = "*";
          outHeaders["Access-Control-Allow-Headers"] = "*";
          outHeaders["Access-Control-Allow-Methods"] = "*";
          res.writeHead(statusCode || 200, outHeaders);
        }
        res.end();
        resolve();
      });
      curl.on("error", (e) => reject(e));
      curl.perform();
    });
  } catch (e) {
    // ما تبعتش writeHead بعد body—ده جوّا try منظّم
    res.writeHead(502, {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "text/plain; charset=utf-8",
    });
    res.end(`Upstream error: ${e?.message || String(e)}`);
  } finally {
    try { curl.close(); } catch {}
  }
}
