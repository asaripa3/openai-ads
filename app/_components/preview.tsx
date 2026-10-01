"use client";

/** Approximation of how a chat_card renders, for copy-length feedback while typing. */
export function AdPreview({
  title,
  body,
  targetUrl,
  imageUrl,
  advertiser,
}: {
  title: string;
  body: string;
  targetUrl: string;
  imageUrl: string;
  advertiser: string;
}) {
  let domain = "";
  try {
    domain = new URL(targetUrl).hostname.replace(/^www\./, "");
  } catch {
    domain = "";
  }

  return (
    <div className="preview-frame">
      <div className="chatcard">
        <div className="thumb" style={imageUrl ? { backgroundImage: `url(${imageUrl})` } : undefined}>
          {imageUrl ? "" : "no image"}
        </div>
        <div className="cc-body">
          <p className="cc-title">{title || "Your headline"}</p>
          <p className="cc-text">{body || "Your description appears here."}</p>
          <div className="cc-meta">
            <span className="sponsored">Sponsored</span>
            <span>{advertiser || domain || "your-site.com"}</span>
          </div>
        </div>
      </div>
      <p className="preview-note">Approximate rendering</p>
    </div>
  );
}
