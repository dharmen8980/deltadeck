"use client";

import type { ReactNode } from "react";
import { Download, Hammer, Laptop, Package, Terminal } from "lucide-react";
import { Command } from "@/components/copy-button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { INSTALL_URL, RELEASES_URL, REPO_URL, UV_INSTALL_URL } from "@/lib/site";

const ONE_LINER = `curl -fsSL ${INSTALL_URL} | bash`;

function A({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="font-medium text-foreground underline underline-offset-4 hover:text-sky-700 dark:hover:text-sky-300">
      {children}
    </a>
  );
}

function Notes({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-1.5 pl-5 text-muted-foreground">{children}</ul>;
}

function Panel({ value, title, children }: { value: string; title: string; children: ReactNode }) {
  return (
    <TabsContent value={value} className="mt-4 space-y-4 rounded-xl border bg-card p-5 text-sm leading-6 sm:p-6">
      <h3 className="text-base font-semibold">{title}</h3>
      {children}
    </TabsContent>
  );
}

const TABS = [
  { value: "mac", label: "Mac app", icon: Laptop },
  { value: "linux", label: "Linux", icon: Terminal },
  { value: "uvx", label: "Run with uvx", icon: Package },
  { value: "source", label: "Build from source", icon: Hammer },
  { value: "download", label: "Direct download", icon: Download },
];

export function InstallTabs() {
  return (
    <Tabs defaultValue="mac" className="gap-0">
      <TabsList aria-label="Ways to install" className="h-auto! w-full flex-wrap justify-start gap-0.5 sm:w-fit">
        {TABS.map(({ value, label, icon: Icon }) => (
          <TabsTrigger key={value} value={value} className="h-8 flex-none px-2.5">
            <Icon aria-hidden /> {label}
          </TabsTrigger>
        ))}
      </TabsList>

      <Panel value="mac" title="Install the Mac app">
        <Command cmd={ONE_LINER} label="Copy the install command" />
        <Notes>
          <li>
            Installs <code className="font-mono text-foreground">DeltaDeck.app</code> to{" "}
            <code className="font-mono text-foreground">~/Applications</code>. Apple Silicon and Intel are both built.
          </li>
          <li>
            The script downloads the app itself, so macOS does not quarantine it and there is no Gatekeeper prompt on
            first launch.
          </li>
          <li>
            Read the script first if you like: <A href={INSTALL_URL}>install.sh</A>.
          </li>
        </Notes>
      </Panel>

      <Panel value="linux" title="Install on Linux">
        <Command cmd={ONE_LINER} label="Copy the install command" />
        <Notes>
          <li>
            Puts the AppImage in <code className="font-mono text-foreground">~/.local/bin</code>. Make sure that folder
            is on your <code className="font-mono text-foreground">PATH</code>.
          </li>
          <li>Desktop builds are for x86_64. On other machines, run it with uvx.</li>
          <li>
            A <code className="font-mono text-foreground">.deb</code> is on the <A href={RELEASES_URL}>Releases</A> page
            too.
          </li>
        </Notes>
      </Panel>

      <Panel value="uvx" title="Run with uvx (macOS, Linux; Windows: WSL)">
        <p className="text-muted-foreground">
          No desktop app, just the server and the web app in your browser. Needs{" "}
          <A href={UV_INSTALL_URL}>uv</A>.
        </p>
        <Command cmd="uvx deltadeck --root ." label="Copy the uvx command" />
        <Notes>
          <li>
            Opens at <code className="font-mono text-foreground">http://127.0.0.1:8765/</code>. Leave out{" "}
            <code className="font-mono text-foreground">--root</code> to choose a folder in the browser.
          </li>
          <li>For a permanent command:</li>
        </Notes>
        <Command cmd="uv tool install deltadeck" label="Copy the uv tool install command" />
        <Notes>
          <li>
            With pipx: <code className="font-mono text-foreground">pipx run deltadeck</code> once, or{" "}
            <code className="font-mono text-foreground">pipx install deltadeck</code> for the command. Add{" "}
            <code className="font-mono text-foreground">--read-only</code> to turn off editing.
          </li>
        </Notes>
      </Panel>

      <Panel value="source" title="Build from source">
        <p className="text-muted-foreground">The install script can build the app on your machine instead of downloading it.</p>
        <Command cmd={`${ONE_LINER} -s -- --build`} label="Copy the build command" />
        <p className="text-muted-foreground">
          Or by hand, with <A href={UV_INSTALL_URL}>uv</A> and Node.js:
        </p>
        <div className="space-y-2">
          <Command cmd={`git clone ${REPO_URL}.git && cd deltadeck`} label="Copy the clone command" />
          <Command cmd="uv sync" label="Copy uv sync" />
          <Command cmd="cd web && npm ci && npm run build && cd .." label="Copy the web build command" />
          <Command cmd="uv run deltadeck --root ~/notes" label="Copy the run command" />
        </div>
        <Notes>
          <li>
            Details, dev mode and tests: <A href={`${REPO_URL}/blob/main/docs/development.md`}>docs/development.md</A>.
          </li>
        </Notes>
      </Panel>

      <Panel value="download" title="Direct download">
        <p className="text-muted-foreground">
          Get the <code className="font-mono text-foreground">.dmg</code> (arm64 or x64),{" "}
          <code className="font-mono text-foreground">.AppImage</code> or{" "}
          <code className="font-mono text-foreground">.deb</code> from the <A href={RELEASES_URL}>Releases</A> page.
          Each release has a <code className="font-mono text-foreground">SHA256SUMS.txt</code>.
        </p>
        <p className="text-muted-foreground">
          The Mac app is not signed yet. A DMG downloaded in the browser is quarantined, and macOS says it cannot be
          opened. After you drag it to Applications, clear the flag once:
        </p>
        <Command cmd="xattr -dr com.apple.quarantine /Applications/DeltaDeck.app" label="Copy the xattr command" />
      </Panel>
    </Tabs>
  );
}
