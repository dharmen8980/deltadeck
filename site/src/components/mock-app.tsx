import {
  Check,
  ChevronRight,
  ClipboardCopy,
  Copy,
  FileCode,
  FileText,
  Folder,
  ListPlus,
  Plus,
  ShoppingBasket,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "cn";

/* A hand-made, static picture of the app. Nothing here is interactive. */

const TREE = [
  { name: "docs", folder: true, dot: true, depth: 0 },
  { name: "setup.md", dot: true, depth: 1, open: true },
  { name: "api.md", depth: 1 },
  { name: "src", folder: true, dot: true, depth: 0 },
  { name: "parser.ts", dot: true, depth: 1, code: true },
  { name: "lexer.ts", depth: 1, code: true },
  { name: "README.md", depth: 0 },
];

function ChangeButtons({ added }: { added?: boolean }) {
  return (
    <span className="absolute -top-3 -right-1 z-10 flex gap-0.5">
      <span className="flex size-5 items-center justify-center rounded-md border border-sky-500/40 bg-background text-sky-700 shadow-sm dark:text-sky-300">
        <Copy className="size-3" />
      </span>
      <span
        className={cn(
          "flex size-5 items-center justify-center rounded-md border shadow-sm",
          added
            ? "border-sky-600 bg-sky-600 text-white"
            : "border-sky-500/40 bg-background text-sky-700 dark:text-sky-300",
        )}
      >
        {added ? <Check className="size-3.5" /> : <Plus className="size-3.5" />}
      </span>
    </span>
  );
}

function Sidebar() {
  return (
    <div className="hidden w-44 shrink-0 border-r bg-muted/30 p-2 text-xs md:block">
      <div className="mb-2 flex items-center gap-1.5 rounded-md bg-sky-500/10 px-2 py-1 font-medium text-sky-800 dark:text-sky-200">
        <Sparkles className="size-3.5" /> What&apos;s new
        <span className="ml-auto tabular-nums">3</span>
      </div>
      <ul className="space-y-0.5">
        {TREE.map((f) => {
          const Icon = f.folder ? Folder : f.code ? FileCode : FileText;
          return (
            <li
              key={f.name}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-1.5 py-0.5",
                f.open && "bg-muted font-medium text-foreground",
                !f.open && "text-muted-foreground",
              )}
              style={{ paddingLeft: `${0.375 + f.depth * 0.75}rem` }}
            >
              <Icon className="size-3.5 shrink-0" />
              <span className="truncate">{f.name}</span>
              {f.dot && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-amber-500" />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Document() {
  return (
    <div className="min-w-0 flex-1 px-6 py-4 sm:px-8">
      <div className="mb-5 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs">
        <span className="font-medium text-amber-800 dark:text-amber-200">Changed since you last viewed it</span>
        <span className="text-muted-foreground">2 blocks</span>
        <span className="ml-auto inline-flex items-center gap-1 rounded-md border bg-background px-1.5 py-0.5 text-sky-800 dark:text-sky-200">
          <ListPlus className="size-3" /> Add all
        </span>
      </div>
      <div className="space-y-4 text-sm leading-6">
        <h3 className="text-lg font-semibold tracking-tight">Install</h3>
        <p className="text-muted-foreground">Clone the repository and install the dependencies with uv.</p>
        <div className="mock-change relative" data-change="modified" data-in-basket="">
          <ChangeButtons added />
          <p className="pr-12">
            Run the parser on a folder with <code className="rounded bg-muted px-1 font-mono text-[12px] whitespace-nowrap">parse --root</code>.
            It now reads <span className="mock-word">every file in one pass</span> and caches the result.
          </p>
        </div>
        <div className="mock-change" data-change="added">
          <ul className="list-disc space-y-1 pl-5">
            <li>Large files are read in chunks.</li>
            <li>Errors name the file and the line.</li>
          </ul>
        </div>
        <h3 className="pt-1 text-base font-semibold tracking-tight">Configure</h3>
        <p className="text-muted-foreground">Settings live in one TOML file at the root of the folder.</p>
      </div>
    </div>
  );
}

function BasketPanel() {
  return (
    <div className="w-full shrink-0 border-t bg-card text-xs lg:w-72 lg:border-t-0 lg:border-l">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <ShoppingBasket className="size-4 text-sky-600 dark:text-sky-400" />
        <span className="flex-1 text-sm font-medium">
          Review basket <span className="font-normal text-muted-foreground">2</span>
        </span>
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <Trash2 className="size-3.5" /> Clear
        </span>
      </div>
      <div className="space-y-2 px-2 py-2">
        <div>
          <div className="px-1 pb-1 font-mono text-[11px] text-muted-foreground">docs/setup.md</div>
          <div className="space-y-1 rounded-md bg-muted/50 px-2 py-1.5">
            <div className="flex items-center gap-2">
              <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />
              <span className="min-w-0 flex-1 truncate">Setup &gt; Install</span>
              <span className="text-[10px] text-muted-foreground">edited</span>
              <X className="size-3 text-muted-foreground" />
            </div>
            <div className="rounded-md border bg-background px-2 py-1 text-muted-foreground">Mention the cache flag</div>
          </div>
        </div>
        <div>
          <div className="px-1 pb-1 font-mono text-[11px] text-muted-foreground">src/parser.ts</div>
          <div className="space-y-1 rounded-md px-2 py-1.5">
            <div className="flex items-center gap-2">
              <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />
              <span className="min-w-0 flex-1 truncate">Line 5-6 · Parser &gt; parse</span>
              <span className="text-[10px] text-muted-foreground">edited</span>
              <X className="size-3 text-muted-foreground" />
            </div>
            <div className="rounded-md border bg-background px-2 py-1 text-muted-foreground/70">Note for the AI (optional)</div>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 border-t px-3 py-2">
        <span className="flex-1 text-[11px] text-muted-foreground">One prompt, a diff per change</span>
        <span className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 font-medium text-primary-foreground">
          <ClipboardCopy className="size-3.5" /> Copy for AI
        </span>
      </div>
    </div>
  );
}

export function MockApp() {
  return (
    <figure className="overflow-hidden rounded-xl border bg-background shadow-xl shadow-black/5 dark:shadow-black/40">
      <div aria-hidden className="select-none">
        <div className="flex items-center gap-3 border-b bg-muted/40 px-3 py-2">
          <span className="flex gap-1.5">
            <span className="size-2.5 rounded-full bg-red-400/80" />
            <span className="size-2.5 rounded-full bg-amber-400/80" />
            <span className="size-2.5 rounded-full bg-emerald-400/80" />
          </span>
          <span className="flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground">
            docs <ChevronRight className="size-3" /> <span className="text-foreground">setup.md</span>
          </span>
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-sky-500/40 px-2 py-0.5 text-xs text-sky-800 dark:text-sky-200">
            <ShoppingBasket className="size-3.5" /> <span className="tabular-nums">2</span>
          </span>
        </div>
        <div className="flex flex-col lg:flex-row">
          <div className="flex min-w-0 flex-1">
            <Sidebar />
            <Document />
          </div>
          <BasketPanel />
        </div>
      </div>
      <figcaption className="sr-only">
        DeltaDeck showing a markdown file with an edited paragraph highlighted in amber and two added list items in
        green, the copy and add buttons on a change, and the review basket with two items, one of them
        &quot;Line 5-6 · Parser &gt; parse (edited)&quot;.
      </figcaption>
    </figure>
  );
}
