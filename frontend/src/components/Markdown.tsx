import { Fragment, type ReactNode } from "react";

/**
 * Small, safe Markdown renderer for assistant answers. It builds React
 * elements directly (no innerHTML), and turns [path/file.ts:L10-L20]
 * citations into clickable badges.
 */

export type Citation = { file: string; startLine: number; endLine: number };

const CITE_RE = /\[([^\]\s]+?\.[A-Za-z0-9]+):L(\d+)(?:-L?(\d+))?\]/g;

function renderInline(text: string, onCite: (c: Citation) => void, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Order matters: code spans first so nothing inside them is parsed.
  const re = /(`[^`]+`)|(\[[^\]\s]+?\.[A-Za-z0-9]+:L\d+(?:-L?\d+)?\])|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${keyBase}-${i++}`;
    if (m[1]) {
      out.push(<code key={k} className="cl-md-code">{m[1].slice(1, -1)}</code>);
    } else if (m[2]) {
      CITE_RE.lastIndex = 0;
      const c = CITE_RE.exec(m[2]);
      if (c) {
        const cite = { file: c[1], startLine: Number(c[2]), endLine: Number(c[3] || c[2]) };
        const name = cite.file.split("/").pop();
        out.push(
          <button key={k} type="button" className="cl-cite" title={`Open ${cite.file} lines ${cite.startLine}-${cite.endLine}`} onClick={() => onCite(cite)}>
            <span className="cl-cite-file">{name}</span>
            <span className="cl-cite-lines">L{cite.startLine}{cite.endLine !== cite.startLine ? `–${cite.endLine}` : ""}</span>
          </button>
        );
      } else out.push(m[2]);
    } else if (m[3]) {
      out.push(<strong key={k} className="text-white font-semibold">{renderInline(m[3].slice(2, -2), onCite, k)}</strong>);
    } else if (m[4]) {
      out.push(<em key={k}>{m[4].slice(1, -1)}</em>);
    } else if (m[5]) {
      out.push(
        <a key={k} href={m[6]} target="_blank" rel="noreferrer noopener" className="text-[#ff8c6b] underline underline-offset-2">
          {m[5].slice(1, m[5].indexOf("]"))}
        </a>
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export default function Markdown({ text, onCite }: { text: string; onCite: (c: Citation) => void }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={key++} className="cl-md-pre">
          {lang && <span className="cl-md-lang">{lang}</span>}
          <code>{body.join("\n")}</code>
        </pre>
      );
      continue;
    }

    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const size = h[1].length <= 2 ? "text-[15px]" : "text-[13px]";
      blocks.push(
        <div key={key++} className={`${size} font-semibold text-white mt-3 mb-1.5`}>
          {renderInline(h[2], onCite, `h${key}`)}
        </div>
      );
      i++;
      continue;
    }

    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ""));
        i++;
      }
      const ListTag = ordered ? "ol" : "ul";
      blocks.push(
        <ListTag key={key++} className={`${ordered ? "list-decimal" : "list-disc"} pl-5 my-1.5 space-y-1 marker:text-[#ff5330]/70`}>
          {items.map((it, j) => (
            <li key={j}>{renderInline(it, onCite, `l${key}-${j}`)}</li>
          ))}
        </ListTag>
      );
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^```|^#{1,4}\s|^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) para.push(lines[i++]);
    blocks.push(
      <p key={key++} className="my-1.5 leading-relaxed">
        {para.map((p, j) => (
          <Fragment key={j}>
            {j > 0 && " "}
            {renderInline(p, onCite, `p${key}-${j}`)}
          </Fragment>
        ))}
      </p>
    );
  }

  return <div className="cl-md">{blocks}</div>;
}
