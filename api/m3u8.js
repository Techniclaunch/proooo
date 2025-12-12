import axios from "axios";

export default async function handler(req, res) {
  const url = req.query.url;

  if (!url) {
    return res.status(400).send("Missing url parameter");
  }

  try {
    const response = await axios.get(url, {
      responseType: "arraybuffer",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      },
    });

    // Pass content type from origin
    const contentType =
      response.headers["content-type"] || "application/octet-stream";

    res.setHeader("Content-Type", contentType);
    res.setHeader("Access-Control-Allow-Origin", "*");

    res.send(response.data);
  } catch (err) {
    console.error(err);
    res.status(500).send("Proxy error");
  }
}
