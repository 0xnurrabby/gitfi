import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { ChevronDown, FileText, Github, Sparkles } from "lucide-react";
import clsx from "clsx";
import type { TokenDetail } from "../../shared/types.js";
import { buttonClass, Card } from "./ui.js";

const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), "className"],
    span: [...(defaultSchema.attributes?.span ?? []), "className"],
    a: [...(defaultSchema.attributes?.a ?? []), "title"],
    img: [
      ...(defaultSchema.attributes?.img ?? []),
      "src",
      "alt",
      "title",
      "width",
      "height",
      "loading",
    ],
  },
  protocols: {
    ...defaultSchema.protocols,
    src: ["http", "https", "data"],
  },
};

function resolveImage(src: string | undefined, repo: string): string | undefined {
  if (!src) return src;
  if (/^(https?:|data:)/i.test(src)) return src;
  const clean = src.replace(/^\.\//, "").replace(/^\//, "");
  return `https://raw.githubusercontent.com/${repo}/HEAD/${clean}`;
}

export function AiSummary({ token }: { token: TokenDetail }) {
  return (
    <Card className="summary-card">
      <div className="summary-head">
        <span className="eyebrow"><Sparkles size={12} /> AI repo brief</span>
        <span className="summary-model mono">3 POINTS · GENERATED</span>
      </div>
      <h3>What this repo actually does.</h3>
      <ol className="summary-list">
        {token.readme.summary.length ? (
          token.readme.summary.map((line, index) => (
            <li key={index}>
              <span className="summary-number mono">0{index + 1}</span>
              <span>{line}</span>
            </li>
          ))
        ) : (
          <li className="muted">Summary is not available yet.</li>
        )}
      </ol>
      <div className="summary-foot">
        <span>Built for informed allocation, not vibes.</span>
        <a href={token.readme.readmeUrl ?? (token.repo.fullName ? `https://github.com/${token.repo.fullName}` : undefined)} target="_blank" rel="noreferrer" className="text-link">
          Source README <Github size={11} />
        </a>
      </div>
    </Card>
  );
}

export function ReadmeView({ token }: { token: TokenDetail }) {
  const [expanded, setExpanded] = useState(false);
  const markdown = token.readme.markdown;
  return (
    <Card className="readme-card">
      <div className="readme-head">
        <span className="eyebrow"><FileText size={12} /> Public README</span>
        <div className="readme-head-actions">
          <span className="readme-file mono">README.md</span>
          <a
            href={`https://github.com/${token.repo.fullName}`}
            target="_blank"
            rel="noreferrer"
            className="readme-github"
          >
            <Github size={13} /> GitHub
          </a>
        </div>
      </div>
      {markdown ? (
        <div className={clsx("markdown-scroll", !expanded && "markdown-collapsed")}>
          <div className="markdown-body">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[[rehypeSanitize, schema]]}
              components={{
                a({ href, children, ...props }) {
                  return (
                    <a
                      href={href}
                      target={href?.startsWith("http") ? "_blank" : undefined}
                      rel="noreferrer noopener"
                      {...props}
                    >
                      {children}
                    </a>
                  );
                },
                img({ src, alt, ...props }) {
                  return (
                    // eslint-disable-next-line jsx-a11y/alt-text
                    <img
                      src={resolveImage(typeof src === "string" ? src : undefined, token.repo.fullName)}
                      alt={alt ?? ""}
                      loading="lazy"
                      {...props}
                    />
                  );
                },
              }}
            >
              {markdown}
            </ReactMarkdown>
          </div>
          {!expanded ? <div className="readme-fade" aria-hidden="true" /> : null}
        </div>
      ) : (
        <div className="readme-empty">
          <FileText size={22} />
          <p>The cached README will appear after the next repository sync.</p>
        </div>
      )}
      {markdown && markdown.length > 1800 ? (
        <button className="readme-expand" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Collapse README" : "Read full README"}
          <ChevronDown size={14} className={expanded ? "chev-up" : ""} />
        </button>
      ) : null}
    </Card>
  );
}
