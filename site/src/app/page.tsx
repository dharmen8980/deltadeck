import type { ReactNode } from "react";
import {
  ArrowRight,
  ClipboardCopy,
  EyeOff,
  FileDiff,
  GitBranch,
  Hand,
  Layers,
  Search,
  ShieldCheck,
  ShoppingBasket,
  Sparkles,
  StepForward,
} from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { GithubIcon } from "@/components/github-icon";
import { InstallTabs } from "@/components/install-tabs";
import { MockApp } from "@/components/mock-app";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DESCRIPTION, REPO_URL } from "@/lib/site";

const PROMPT = `Review feedback on recent changes. For each item, revise as noted.

## src/parser.ts

### 1. Line 5-6 · Parser > parse (edited)

\`\`\`diff
-    const files = this.walk(root);
-    return files.map((f) => this.read(f));
+    const files = this.walk(root, { cache: true });
+    return this.readAll(files);
\`\`\`

Note: keep the old read() for single files.`;

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border bg-muted px-1 font-mono text-[11px] font-medium text-foreground">
      {children}
    </kbd>
  );
}

function Section({
  id,
  title,
  intro,
  children,
}: {
  id: string;
  title: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="mx-auto max-w-6xl px-4 py-4 sm:px-6 sm:py-8"
    >
      <h2
        id={`${id}-title`}
        className="text-2xl font-semibold tracking-tight sm:text-3xl"
      >
        {title}
      </h2>
      {intro && <p className="mt-3 max-w-2xl text-muted-foreground">{intro}</p>}
      <div className="mt-10">{children}</div>
    </section>
  );
}

function Header() {
  return (
    <header className="sticky top-0 z-20 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:px-6">
        <a href="#top" className="flex items-center gap-2 font-semibold">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="" width={24} height={24} />
          DeltaDeck
        </a>
        <nav
          aria-label="Sections"
          className="ml-auto flex items-center gap-1 text-sm"
        >
          <a
            href="#how"
            className="hidden rounded-md px-2.5 py-1.5 text-muted-foreground hover:text-foreground sm:block"
          >
            How it works
          </a>
          <a
            href="#features"
            className="hidden rounded-md px-2.5 py-1.5 text-muted-foreground hover:text-foreground sm:block"
          >
            Features
          </a>
          <a
            href="#install"
            className="rounded-md px-2.5 py-1.5 text-muted-foreground hover:text-foreground"
          >
            Install
          </a>
          <a
            href="#faq"
            className="hidden rounded-md px-2.5 py-1.5 text-muted-foreground hover:text-foreground sm:block"
          >
            FAQ
          </a>
          <Button asChild variant="ghost" size="icon-sm">
            <a href={REPO_URL} aria-label="DeltaDeck on GitHub">
              <GithubIcon className="size-4" />
            </a>
          </Button>
        </nav>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section
      aria-labelledby="hero-title"
      className="mx-auto max-w-6xl px-4 pt-8 pb-8 sm:px-6 sm:pt-12"
    >
      <Badge
        variant="outline"
        className="mb-6 h-6 gap-1.5 px-2.5 text-muted-foreground"
      >
        <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />{" "}
        Free, open source, local only
      </Badge>
      <h1
        id="hero-title"
        className="text-5xl font-semibold tracking-tight sm:text-6xl"
      >
        DeltaDeck
      </h1>
      <p className="mt-4 text-2xl font-medium tracking-tight sm:text-3xl">
        Every change,{" "}
        <span className="text-amber-600 dark:text-amber-400">stacked</span> for
        review.
      </p>
      <p className="mt-5 max-w-2xl text-lg leading-relaxed text-muted-foreground">
        {DESCRIPTION}
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Button asChild size="lg" className="h-10 px-4">
          <a href="#install">
            Install <ArrowRight data-icon="inline-end" />
          </a>
        </Button>
        <Button asChild size="lg" variant="outline" className="h-10 px-4">
          <a href={REPO_URL}>
            <GithubIcon className="size-4" /> View on GitHub
          </a>
        </Button>
      </div>
      <div className="mt-14">
        <MockApp />
      </div>
    </section>
  );
}

const STEPS = [
  {
    icon: Layers,
    title: "The deck",
    body: (
      <>
        Every change since you last looked, across the folder.{" "}
        <strong className="font-medium text-foreground">What&apos;s new</strong>{" "}
        lists them, newest first. Files you have not seen get a dot.
      </>
    ),
  },
  {
    icon: StepForward,
    title: "Flip through",
    body: (
      <>
        Open a file and the changes are highlighted in place. <Kbd>n</Kbd> and{" "}
        <Kbd>p</Kbd> jump to the next and previous change.
      </>
    ),
  },
  {
    icon: Hand,
    title: "Pick cards",
    body: (
      <>
        <Kbd>b</Kbd> puts a change in the review basket, with a note if you
        like. <Kbd>c</Kbd> copies just that one change.
      </>
    ),
  },
  {
    icon: ClipboardCopy,
    title: "Deal back",
    body: (
      <>
        <strong className="font-medium text-foreground">Copy for AI</strong>{" "}
        builds one prompt with a diff and your note per change. Paste it into
        your agent.
      </>
    ),
  },
];

function HowItWorks() {
  return (
    <Section
      id="how"
      title="How it works"
      intro="Your agent edited twelve files. You want to read what changed, not the whole repository."
    >
      <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map(({ icon: Icon, title, body }, i) => (
          <li key={title} className="relative rounded-xl border bg-card p-5">
            <div className="flex items-center gap-3">
              <span className="flex size-8 items-center justify-center rounded-lg bg-sky-500/10 text-sky-700 dark:text-sky-300">
                <Icon className="size-4" aria-hidden />
              </span>
              <span className="text-xs font-medium text-muted-foreground tabular-nums">
                Step {i + 1}
              </span>
            </div>
            <h3 className="mt-4 font-semibold">{title}</h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {body}
            </p>
          </li>
        ))}
      </ol>
      <div className="mt-10 grid items-start gap-6 lg:grid-cols-[1fr_1.2fr]">
        <div className="space-y-3 text-sm leading-6 text-muted-foreground">
          <h3 className="text-base font-semibold text-foreground">
            What lands in your agent
          </h3>
          <p>
            One markdown prompt. Each item has its location, whether it was
            added, edited or removed, a diff of the old and new text, and your
            note.
          </p>
          <p>
            Paths are relative to the git repository, so an agent running at the
            repo root finds the files. Code items carry the line range and the
            enclosing symbol.
          </p>
        </div>
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
            <ClipboardCopy className="size-3.5" aria-hidden />
            <span className="flex-1">Copied prompt</span>
            <CopyButton text={PROMPT} label="Copy the example prompt" />
          </div>
          <pre className="overflow-x-auto p-4 font-mono text-[12.5px] leading-5">
            <code>
              {PROMPT.split("\n").map((line, i) => (
                <span
                  key={i}
                  className={
                    line.startsWith("+")
                      ? "block text-emerald-700 dark:text-emerald-400"
                      : line.startsWith("-")
                        ? "block text-red-700 dark:text-red-400"
                        : line.startsWith("#")
                          ? "block font-semibold"
                          : "block"
                  }
                >
                  {line || " "}
                </span>
              ))}
            </code>
          </pre>
        </div>
      </div>
    </Section>
  );
}

const FEATURES = [
  {
    icon: FileDiff,
    title: "Changes in the rendered view",
    body: "Edited blocks in amber, new ones in green, removals as a dashed line. In rendered markdown and .docx, and line by line in code and text.",
  },
  {
    icon: Sparkles,
    title: "What's new, folder-wide",
    body: "A feed of every file that changed since you last opened it, with what changed in each, including files git never sees, like git-ignored agent memory, skills and plans. The history stays in the app's data dir, never in your folder.",
  },
  {
    icon: ShoppingBasket,
    title: "Review basket and Copy for AI",
    body: "Pick changes, add a note to each, copy one prompt: diffs, repo-relative paths, line ranges and symbols. Session only, nothing saved.",
  },
  {
    icon: GitBranch,
    title: "Git, read-only",
    body: "See what changed since the last commit with the same highlights, an Uncommitted list with +/- counts, and blame. Nothing is written to the repo.",
  },
  {
    icon: Search,
    title: "Search and autocomplete",
    body: "Project-wide full-text search with folder and type filters. With editing on, the editor completes names from the whole folder.",
  },
  {
    icon: EyeOff,
    title: "Hidden files, handled",
    body: "A short list (.git, node_modules, __pycache__, .venv) is hidden for you, but never files git tracks. Right-click anything else to hide it. One button lists everything hidden, with a checkbox to show each item. Git-ignored files stay visible unless you hide them. .env files and private keys stay locked and open read-only after a confirm.",
  },
  {
    icon: ShieldCheck,
    title: "Local only",
    body: "Nothing leaves your machine. No AI calls, no account, no telemetry. --read-only turns off editing.",
  },
];

function Features() {
  return (
    <Section
      id="features"
      title="Built for reviewing AI work"
      intro="For tech leads and developers who spend the day checking what agents wrote. PMs reading the docs are welcome too."
    >
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map(({ icon: Icon, title, body }) => (
          <li key={title} className="rounded-xl border bg-card p-5">
            <Icon className="size-5 text-muted-foreground" aria-hidden />
            <h3 className="mt-3 font-semibold">{title}</h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {body}
            </p>
          </li>
        ))}
        <li className="rounded-xl border border-dashed p-5 text-sm leading-6 text-muted-foreground">
          <h3 className="text-base font-semibold text-foreground">
            Opens what agents touch
          </h3>
          <p className="mt-2">
            Markdown with mermaid, Word .docx, source code with an outline,
            JSON, CSV and xlsx tables, images, PDFs and large logs. Markdown and
            .docx export to PDF.
          </p>
        </li>
      </ul>
    </Section>
  );
}

function Install() {
  return (
    <Section
      id="install"
      title="Install"
      intro="Desktop builds are for Mac (Apple Silicon and Intel) and Linux x86_64. On other Linux machines, run it with uvx. Windows is not supported; use WSL."
    >
      <InstallTabs />
    </Section>
  );
}

const FAQ = [
  {
    q: "Is my code sent anywhere?",
    a: "No. A small server on 127.0.0.1 reads the folder and your browser or the desktop app shows it. Nothing goes over the network.",
  },
  {
    q: "Does it call an AI?",
    a: "No. Copy for AI puts a prompt on your clipboard. You paste it into the agent you already use.",
  },
  {
    q: "Does it edit my files?",
    a: "Only when you do. Files open read-only; pressing Edit opens an editor, and file management comes with version history and undo. Start it with --read-only, or turn off Allow editing in the desktop app's menu, to remove editing altogether.",
  },
  {
    q: "Why is the Mac app unsigned?",
    a: "It is an early project without an Apple Developer account yet. The install script downloads the app with curl, so macOS shows no prompt. For a browser download, see Direct download above.",
  },
  {
    q: "Which files does it show?",
    a: "Markdown, .mmd diagrams, Word .docx, source code, plain text and logs, JSON, CSV, xlsx, images and PDFs. Change highlights cover markdown, .docx, code and text.",
  },
];

function Faq() {
  return (
    <Section id="faq" title="FAQ">
      <dl className="grid gap-x-10 gap-y-8 md:grid-cols-2">
        {FAQ.map(({ q, a }) => (
          <div key={q}>
            <dt className="font-semibold">{q}</dt>
            <dd className="mt-2 text-sm leading-6 text-muted-foreground">
              {a}
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function Footer() {
  return (
    <footer className="border-t">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:px-6">
        <span className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="" width={18} height={18} />
          DeltaDeck · Made for reviewing AI work
        </span>
        <span className="flex gap-4 sm:ml-auto">
          <a
            href={REPO_URL}
            className="inline-flex items-center gap-1.5 hover:text-foreground"
          >
            <GithubIcon className="size-3.5" /> GitHub
          </a>
          <a
            href={`${REPO_URL}/blob/main/LICENSE`}
            className="hover:text-foreground"
          >
            MIT License
          </a>
        </span>
      </div>
    </footer>
  );
}

export default function Home() {
  return (
    <>
      <a
        href="#install"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2"
      >
        Skip to install
      </a>
      <Header />
      <main id="top">
        <Hero />
        <HowItWorks />
        <Features />
        <Install />
        <Faq />
      </main>
      <Footer />
    </>
  );
}

export const dynamic = "force-static";
