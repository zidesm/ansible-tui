// deno-lint-ignore-file no-explicit-any
// Ansible TUI Runner — single file, zero local dependencies
//
// Run (binary):   ansible-tui [inventory.yml] [playbook.yml]
// Run (local):    deno run --allow-read --allow-run --allow-write --allow-env app.tsx
// Run (remote):   deno run --allow-read --allow-run --allow-write --allow-env \
//                   --import-map=https://raw.githubusercontent.com/congzhangzh/ansible-tui/main/deno.json \
//                   https://raw.githubusercontent.com/congzhangzh/ansible-tui/main/app.tsx

// @deno-types="npm:@types/react@^18"
import { useState, useMemo, useEffect, useRef } from "react";
import { render, Box, Text, useInput, useApp, useStdout } from "ink";
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
// @deno-types="npm:@types/js-yaml@^4"
import { load as yamlLoad } from "js-yaml";
import { resolve, dirname, relative, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";

// ===== Version =====

const VERSION = "0.2.7";

// ===== Types =====

interface HostGroup {
  name: string;
  hosts: string[];
}

interface FlatItem {
  id: string;
  label: string;
  depth: number;
  type: "play" | "block" | "task";
  tags: string[];
  hasNever: boolean;
  playIndex: number;
  parentId?: string;
}

interface HostListItem {
  kind: "group" | "host";
  name: string;
  group?: string;
}

// ===== YAML Parsing =====

function parseIniInventory(content: string): HostGroup[] {
  const groups: HostGroup[] = [];
  const lines = content.split("\n");
  let currentGroup = "";
  const hosts: string[] = [];

  for (let line of lines) {
    line = line.trim();
    
    // Skip empty lines and comments
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    
    // Detect group headers [groupname]
    if (line.startsWith("[") && line.endsWith("]")) {
      // Save previous group if it has hosts
      if (currentGroup && hosts.length > 0) {
        groups.push({ name: currentGroup, hosts: [...hosts] });
      }
      currentGroup = line.slice(1, -1).trim();
      hosts.length = 0; // Clear hosts for new group
    } else if (currentGroup) {
      // Parse hosts in group (can have inline variables like "host1 ansible_host=1.2.3.4")
      const hostName = line.split(/\s+/)[0]; // Take everything before whitespace as hostname
      if (hostName) {
        hosts.push(hostName);
      }
    }
  }
  
  // Don't forget the last group
  if (currentGroup && hosts.length > 0) {
    groups.push({ name: currentGroup, hosts });
  }
  
  return groups;
}

function parseInventoryFile(filePath: string): HostGroup[] {
  const content = readFileSync(filePath, "utf-8");
  
  // Check if it's an INI file (no extension or .ini/.cfg extension)
  if (filePath.endsWith("ini") || filePath.endsWith("cfg") || !filePath.includes(".")) {
    // Try parsing as INI first
    try {
      const groups = parseIniInventory(content);
      if (groups.length > 0) return groups;
    } catch {
      // Fall through to YAML parsing
    }
  }
  
  // Parse as YAML
  try {
    const data = yamlLoad(content) as any;
    const groups: HostGroup[] = [];
    for (const [name, val] of Object.entries(data?.all?.children || {})) {
      const hosts = Object.keys((val as any)?.hosts || {});
      if (hosts.length > 0) groups.push({ name, hosts });
    }
    return groups;
  } catch {
    // If YAML parsing fails, try INI as fallback
    return parseIniInventory(content);
  }
}

function parseInventoryDirectory(dirPath: string): HostGroup[] {
  const groups: HostGroup[] = [];
  
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      
      if (entry.isDirectory()) {
        // Look for hosts file in subdirectory
        const hostsNames = ["hosts.yml", "hosts.yaml", "main.yml", "main.yaml", "hosts"];
        let hostsFile = null;
        
        for (const name of hostsNames) {
          const candidate = join(fullPath, name);
          if (existsSync(candidate)) {
            hostsFile = candidate;
            break;
          }
        }
        
        if (hostsFile) {
          const data = yamlLoad(readFileSync(hostsFile, "utf-8")) as any;
          const hosts: string[] = [];
          
          // Support multiple formats:
          // Format 1: { hosts: [host1, host2] }
          if (Array.isArray(data?.hosts)) {
            hosts.push(...data.hosts);
          }
          // Format 2: { hosts: { host1: null, host2: null } }
          else if (data?.hosts && typeof data.hosts === "object") {
            hosts.push(...Object.keys(data.hosts));
          }
          // Format 3: Direct array at root level
          else if (Array.isArray(data)) {
            hosts.push(...data.filter(h => typeof h === "string"));
          }
          
          if (hosts.length > 0) {
            groups.push({ name: entry.name, hosts });
          }
        }
      } else if (entry.isFile() && (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml"))) {
        // YAML files at root level (filename becomes group name)
        const groupName = entry.name.replace(/\.(yml|yaml)$/, "");
        const data = yamlLoad(readFileSync(fullPath, "utf-8")) as any;
        const hosts: string[] = [];
        
        // Support multiple formats
        if (Array.isArray(data?.hosts)) {
          hosts.push(...data.hosts);
        } else if (data?.hosts && typeof data.hosts === "object") {
          hosts.push(...Object.keys(data.hosts));
        } else if (Array.isArray(data)) {
          hosts.push(...data.filter(h => typeof h === "string"));
        }
        
        if (hosts.length > 0) {
          groups.push({ name: groupName, hosts });
        }
      } else if (entry.isFile() && (entry.name.endsWith(".ini") || entry.name.endsWith(".cfg") || (!entry.name.includes(".") && !entry.name.startsWith(".")))) {
        // INI files or extensionless files (like "management", "hosts", etc)
        try {
          const content = readFileSync(fullPath, "utf-8");
          const parsedGroups = parseIniInventory(content);
          
          if (parsedGroups.length > 0) {
            // If file has multiple groups, add them all
            groups.push(...parsedGroups);
          } else {
            // If no groups found in INI, treat whole file as single group with filename as group name
            const groupName = entry.name;
            const hosts = content
              .split("\n")
              .map(line => line.trim())
              .filter(line => line && !line.startsWith("#") && !line.startsWith(";"))
              .map(line => line.split(/\s+/)[0]);
            
            if (hosts.length > 0) {
              groups.push({ name: groupName, hosts });
            }
          }
        } catch (e) {
          // Skip files that can't be parsed
        }
      }
    }
  } catch (e) {
    console.error(`Error parsing inventory directory: ${e}`);
  }
  
  return groups;
}

function parseInventory(inventoryPath: string): HostGroup[] {
  try {
    const stat = statSync(inventoryPath);
    if (stat.isDirectory()) {
      return parseInventoryDirectory(inventoryPath);
    } else {
      return parseInventoryFile(inventoryPath);
    }
  } catch {
    // Fall back to file parsing for backward compatibility
    return parseInventoryFile(inventoryPath);
  }
}

interface ParsedNode {
  name: string;
  tags: string[];
  hasNever: boolean;
  type: "block" | "task";
  children?: ParsedNode[];
}

function extractNodes(tasks: any[], inherited: string[] = []): ParsedNode[] {
  if (!Array.isArray(tasks)) return [];
  return tasks.flatMap((t) => {
    if (!t || typeof t !== "object") return [];
    const own: string[] = Array.isArray(t.tags) ? t.tags : t.tags ? [t.tags] : [];
    const allTags = [...new Set([...inherited, ...own])];
    if (t.block) {
      const children = extractNodes(t.block, allTags);
      if (!t.name) return children; // unnamed block — flatten
      return [{
        name: t.name, type: "block" as const, children,
        tags: allTags.filter((x) => x !== "never"), hasNever: allTags.includes("never"),
      }];
    }
    if (!t.name) return [];
    return [{
      name: t.name, type: "task" as const,
      tags: allTags.filter((x) => x !== "never"), hasNever: allTags.includes("never"),
    }];
  });
}

function parsePlaybook(filePath: string): FlatItem[] {
  try {
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      return parsePlaybookDirectory(filePath);
    } else {
      return parsePlaybookFile(filePath);
    }
  } catch {
    // Fall back to file parsing for backward compatibility
    return parsePlaybookFile(filePath);
  }
}

function parsePlaybookFile(filePath: string): FlatItem[] {
  const plays = yamlLoad(readFileSync(filePath, "utf-8")) as any[];
  const items: FlatItem[] = [];
  (plays || []).forEach((play: any, pi: number) => {
    if (!play?.name) return;
    const pt: string[] = Array.isArray(play.tags) ? play.tags : play.tags ? [play.tags] : [];
    items.push({
      id: `p${pi}`, label: play.name, depth: 0, type: "play",
      tags: pt.filter((t) => t !== "never"), hasNever: pt.includes("never"), playIndex: pi,
    });
    let taskIdx = 0, blockIdx = 0;
    const flatten = (nodes: ParsedNode[], depth: number, parentId?: string) => {
      for (const node of nodes) {
        if (node.type === "block") {
          const id = `p${pi}b${blockIdx++}`;
          items.push({
            id, label: node.name, depth, type: "block",
            tags: node.tags, hasNever: node.hasNever, playIndex: pi, parentId,
          });
          if (node.children) flatten(node.children, depth + 1, id);
        } else {
          items.push({
            id: `p${pi}t${taskIdx++}`, label: node.name, depth, type: "task",
            tags: node.tags, hasNever: node.hasNever, playIndex: pi, parentId,
          });
        }
      }
    };
    flatten(extractNodes(play.tasks || []), 1);
  });
  return items;
}

function parsePlaybookDirectory(dirPath: string): FlatItem[] {
  const items: FlatItem[] = [];
  let playIndex = 0;
  
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    const yamlFiles = entries
      .filter((e) => e.isFile() && (e.name.endsWith(".yml") || e.name.endsWith(".yaml")))
      .sort((a, b) => a.name.localeCompare(b.name));
    
    for (const entry of yamlFiles) {
      const fullPath = join(dirPath, entry.name);
      try {
        const plays = yamlLoad(readFileSync(fullPath, "utf-8")) as any[];
        (plays || []).forEach((play: any) => {
          const playName = play?.name || entry.name.replace(/\.(yml|yaml)$/, "");
          if (!playName) return;
          
          const pt: string[] = Array.isArray(play.tags) ? play.tags : play.tags ? [play.tags] : [];
          const pi = playIndex;
          items.push({
            id: `p${pi}`, label: playName, depth: 0, type: "play",
            tags: pt.filter((t) => t !== "never"), hasNever: pt.includes("never"), playIndex: pi,
          });
          let taskIdx = 0, blockIdx = 0;
          const flatten = (nodes: ParsedNode[], depth: number, parentId?: string) => {
            for (const node of nodes) {
              if (node.type === "block") {
                const id = `p${pi}b${blockIdx++}`;
                items.push({
                  id, label: node.name, depth, type: "block",
                  tags: node.tags, hasNever: node.hasNever, playIndex: pi, parentId,
                });
                if (node.children) flatten(node.children, depth + 1, id);
              } else {
                items.push({
                  id: `p${pi}t${taskIdx++}`, label: node.name, depth, type: "task",
                  tags: node.tags, hasNever: node.hasNever, playIndex: pi, parentId,
                });
              }
            }
          };
          flatten(extractNodes(play.tasks || []), 1);
          playIndex++;
        });
      } catch (e) {
        // Skip files that can't be parsed
      }
    }
  } catch (e) {
    // Silently fail
  }
  
  return items;
}

// ===== Command Builder =====

function buildCommand(
  hosts: Set<string>,
  checked: Set<string>,
  items: FlatItem[],
  inv: string,
  pb: string,
  allHostsSelected: boolean,
): string {
  const parts = ["ansible-playbook", "-i", inv, pb];
  if (allHostsSelected) {
    parts.push("--limit", "all");
  } else if (hosts.size > 0) {
    parts.push("--limit", [...hosts].join(","));
  }
  const tags = new Set<string>();
  for (const id of checked) {
    const it = items.find((i) => i.id === id);
    if (!it || it.type !== "task") continue;
    it.tags.forEach((t) => tags.add(t));
    const play = items.find((i) => i.type === "play" && i.playIndex === it.playIndex);
    if (play?.hasNever) play.tags.forEach((t) => tags.add(t));
  }
  if (tags.size > 0) parts.push("--tags", [...tags].join(","));
  return parts.join(" ");
}

// ===== State Persistence =====

interface PersistedState {
  hostSel: string[];
  taskSel: string[];
  expanded: string[];
  expandedGroups: string[];
  checkFlag?: boolean;
  diffFlag?: boolean;
  section?: "hosts" | "playbook";
  hCur?: number;
  pCur?: number;
}

function loadState(filePath: string): PersistedState | null {
  try {
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    if (data && Array.isArray(data.hostSel) && Array.isArray(data.taskSel) && Array.isArray(data.expanded)) {
      // Ensure expandedGroups exists for backward compatibility
      if (!Array.isArray(data.expandedGroups)) data.expandedGroups = [];
      return data as PersistedState;
    }
    return null;
  } catch { return null; }
}

function saveState(filePath: string, state: PersistedState): void {
  try { writeFileSync(filePath, JSON.stringify(state, null, 2) + "\n"); } catch { /* ignore */ }
}

// ===== App =====

type Phase = "select" | "running" | "done";

let showCmd: string | null = null;
let currentState: PersistedState | null = null;

function App({ hostGroups, items, inv, pb, cwd, initialState }: {
  hostGroups: HostGroup[]; items: FlatItem[]; inv: string; pb: string; cwd: string;
  initialState?: PersistedState | null;
}) {
  const app = useApp();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 40;

  // -- Selection state (persisted across phases) --
  const [section, setSection] = useState<"hosts" | "playbook">(initialState?.section ?? "hosts");
  const [hCur, setHCur] = useState(initialState?.hCur ?? 0);
  const [pCur, setPCur] = useState(initialState?.pCur ?? 0);
  const [hostSel, setHostSel] = useState<Set<string>>(() => new Set(initialState?.hostSel ?? []));
  const [taskSel, setTaskSel] = useState<Set<string>>(() => new Set(initialState?.taskSel ?? []));
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(initialState?.expanded ?? []));
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set(initialState?.expandedGroups ?? [...hostGroups.map(g => g.name)]));
  const [checkFlag, setCheckFlag] = useState(initialState?.checkFlag ?? false);
  const [diffFlag, setDiffFlag] = useState(initialState?.diffFlag ?? false);
  const [warnMsg, setWarnMsg] = useState<string | null>(null);
  const [searchMode, setSearchMode] = useState(false);
  const [searchPanel, setSearchPanel] = useState<"hosts" | "playbook" | null>(null);
  const [hostSearchQuery, setHostSearchQuery] = useState("");
  const [playbookSearchQuery, setPlaybookSearchQuery] = useState("");

  const flatHosts = useMemo<HostListItem[]>(() => {
    const out: HostListItem[] = [];
    for (const g of hostGroups) {
      out.push({ kind: "group", name: g.name });
      if (expandedGroups.has(g.name)) {
        for (const h of g.hosts) out.push({ kind: "host", name: h, group: g.name });
      }
    }
    return out;
  }, [hostGroups, expandedGroups]);

  // Filter hosts based on search query
  const filteredHosts = useMemo<HostListItem[]>(() => {
    if (!hostSearchQuery) return flatHosts;
    const query = hostSearchQuery.toLowerCase();
    const out: HostListItem[] = [];
    for (const group of hostGroups) {
      const groupMatches = group.name.toLowerCase().includes(query);
      const matchingHosts = group.hosts.filter((h) => h.toLowerCase().includes(query));
      if (groupMatches || matchingHosts.length > 0) {
        out.push({ kind: "group", name: group.name });
        const hostsToShow = groupMatches ? group.hosts : matchingHosts;
        for (const h of hostsToShow) {
          out.push({ kind: "host", name: h, group: group.name });
        }
      }
    }
    return out;
  }, [flatHosts, hostGroups, hostSearchQuery]);

  // Track live state for persistence on exit
  useEffect(() => {
    currentState = { hostSel: [...hostSel], taskSel: [...taskSel], expanded: [...expanded], expandedGroups: [...expandedGroups], checkFlag, diffFlag, section, hCur, pCur };
  }, [hostSel, taskSel, expanded, expandedGroups, checkFlag, diffFlag, section, hCur, pCur]);

  // Auto-dismiss warning after 2s
  useEffect(() => {
    if (!warnMsg) return;
    const t = setTimeout(() => setWarnMsg(null), 2000);
    return () => clearTimeout(t);
  }, [warnMsg]);

  useEffect(() => {
    setHCur(0);
  }, [hostSearchQuery]);

  useEffect(() => {
    setPCur(0);
  }, [playbookSearchQuery]);

  // -- Execution state --
  const [phase, setPhase] = useState<Phase>("select");
  const [runCmd, setRunCmd] = useState("");
  const [runExitCode, setRunExitCode] = useState<number | null>(null);
  const [lastResult, setLastResult] = useState("");
  const [outputScroll, setOutputScroll] = useState(0);
  const outputRef = useRef("");
  const childRef = useRef<ChildProcess | null>(null);
  const [tick, setTick] = useState(0);

  // Derived counts for panel headers
  const allUniqueHosts = useMemo(() => {
    const unique = new Set<string>();
    for (const g of hostGroups) {
      for (const h of g.hosts) {
        unique.add(h);
      }
    }
    return unique;
  }, [hostGroups]);
  
  const totalHosts = allUniqueHosts.size;
  const selectedHostCount = hostSel.size;
  const totalTasks = useMemo(() => items.filter((i) => i.type === "task").length, [items]);
  const selectedTaskCount = useMemo(
    () => [...taskSel].filter((id) => items.find((i) => i.id === id)?.type === "task").length,
    [taskSel, items],
  );
  const allHostsSelected = totalHosts > 0 && selectedHostCount === totalHosts;

  const visible = useMemo(() => items.filter((i) => {
    if (i.type === "play") return true;
    // Block or task: check if the play is expanded
    const playId = `p${i.playIndex}`;
    if (!expanded.has(playId)) return false;
    // Walk parent chain — all ancestor blocks must be expanded
    let pid = i.parentId;
    while (pid) {
      if (!expanded.has(pid)) return false;
      pid = items.find((x) => x.id === pid)?.parentId;
    }
    return true;
  }), [items, expanded]);

  const filteredVisible = useMemo(() => {
    if (!playbookSearchQuery) return visible;
    const query = playbookSearchQuery.toLowerCase();
    return visible.filter((it) =>
      it.label.toLowerCase().includes(query) ||
      it.tags.some((t) => t.toLowerCase().includes(query))
    );
  }, [visible, playbookSearchQuery]);

  // Viewports for scrolling
  const viewH = Math.max(10, rows - 19); // Reserved rows for header, borders, commands, footer

  const safePCur = Math.max(0, Math.min(pCur, filteredVisible.length - 1));
  const pScrollStart = Math.max(0, Math.min(safePCur - Math.floor(viewH / 2), Math.max(0, filteredVisible.length - viewH)));
  const pbSlice = filteredVisible.slice(pScrollStart, pScrollStart + viewH);

  const safeHCur = Math.max(0, Math.min(hCur, filteredHosts.length - 1));
  const hScrollStart = Math.max(0, Math.min(safeHCur - Math.floor(viewH / 2), Math.max(0, filteredHosts.length - viewH)));
  const hostSlice = filteredHosts.slice(hScrollStart, hScrollStart + viewH);

  const cmd = buildCommand(hostSel, taskSel, items, inv, pb, allHostsSelected);
  const fullCmd = cmd + (checkFlag ? " --check" : "") + (diffFlag ? " --diff" : "");
  const hasTags = cmd.includes("--tags");
  const hasTaskSelection = [...taskSel].some((id) => items.find((i) => i.id === id)?.type === "task");
  const hasUntaggedSel = [...taskSel].some((id) => {
    const it = items.find((i) => i.id === id);
    if (!it || it.type !== "task" || it.tags.length > 0 || it.hasNever) return false;
    const play = items.find((i) => i.type === "play" && i.playIndex === it.playIndex);
    return !play?.hasNever;
  });

  // -- Command execution effect --
  useEffect(() => {
    if (phase !== "running") return;

    outputRef.current = "";
    const child = spawn("sh", ["-c", runCmd], {
      cwd,
      env: { ...process.env, ANSIBLE_FORCE_COLOR: "true" },
    });
    childRef.current = child;

    const onData = (data: any) => { outputRef.current += data.toString(); };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    // Periodic re-render to stream output (every 200ms)
    const timer = setInterval(() => setTick((t) => t + 1), 200);

    child.on("close", (code) => {
      clearInterval(timer);
      childRef.current = null;
      const c = code ?? 1;
      setRunExitCode(c);
      setLastResult(c === 0 ? "✓ Last run succeeded" : `✗ Last run failed (exit ${c})`);
      setOutputScroll(999999); // Clamp in render → scroll to bottom
      setPhase("done");
      setTick((t) => t + 1); // Final flush
    });

    return () => {
      clearInterval(timer);
      if (child.exitCode === null) child.kill();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, runCmd]);

  // -- Input handling --
  useInput((input, key) => {
    // --- Search mode handling ---
    if (searchMode) {
      if (key.escape) {
        if (searchPanel === "hosts") {
          setHostSearchQuery("");
          setHCur(0);
        } else if (searchPanel === "playbook") {
          setPlaybookSearchQuery("");
          setPCur(0);
        }
        setSearchMode(false);
        return;
      }
      if (key.return) {
        setSearchMode(false);
        return;
      }
      const isBackspace =
        key.backspace ||
        key.delete ||
        input === "\b" ||
        input === "\x7f";
      if (isBackspace) {
        if (searchPanel === "hosts") {
          setHostSearchQuery((q) => q.slice(0, -1));
        } else if (searchPanel === "playbook") {
          setPlaybookSearchQuery((q) => q.slice(0, -1));
        }
        return;
      }
      if (input && input.length === 1 && input.charCodeAt(0) >= 32) {
        if (searchPanel === "hosts") {
          setHostSearchQuery((q) => q + input);
        } else if (searchPanel === "playbook") {
          setPlaybookSearchQuery((q) => q + input);
        }
        return;
      }
      return;
    }

    // --- Running phase: only allow cancel ---
    if (phase === "running") {
      if (input === "q") childRef.current?.kill();
      return;
    }

    // --- Done phase: scroll output, Enter to go back ---
    if (phase === "done") {
      const totalLines = outputRef.current.split("\n").length;
      const maxScroll = Math.max(0, totalLines - (rows - 4));
      if (key.upArrow) setOutputScroll((s) => Math.max(0, Math.min(s, maxScroll) - 1));
      if (key.downArrow) setOutputScroll((s) => Math.min(maxScroll, s + 1));
      if (key.pageUp) setOutputScroll((s) => Math.max(0, s - Math.floor((rows - 4) / 2)));
      if (key.pageDown) setOutputScroll((s) => Math.min(maxScroll, s + Math.floor((rows - 4) / 2)));
      if (key.return) { setPhase("select"); return; }
      if (input === "q") return app.exit();
      return;
    }

    // --- Select phase ---
    if (input === "q") return app.exit();
    if (input === "c") return setCheckFlag((f) => !f);
    if (input === "d") return setDiffFlag((f) => !f);
    if (input === "/") {
      setSearchPanel(section);
      setSearchMode(true);
      return;
    }
    if (input === "r") {
      // Guard: warn if no hosts or no tasks selected
      if (hostSel.size === 0) { setWarnMsg("⚠ No hosts selected — add hosts first (Space)"); return; }
      setRunCmd(fullCmd);
      setRunExitCode(null);
      setOutputScroll(0);
      setPhase("running");
      return;
    }
    if (input === "s") {
      showCmd = fullCmd;
      return app.exit();
    }
    if (key.tab) return setSection((s) => (s === "hosts" ? "playbook" : "hosts"));

    // -- Expand all / collapse all --
    if (input === "e") {
      if (section === "hosts") {
        // Toggle all host groups
        const allGroupNames = hostGroups.map((g) => g.name);
        setExpandedGroups((prev) => {
          const allExpanded = allGroupNames.length > 0 && allGroupNames.every((name) => prev.has(name));
          return allExpanded ? new Set() : new Set(allGroupNames);
        });
      } else if (section === "playbook") {
        // Toggle all plays and blocks
        const playIds = items.filter((i) => i.type === "play").map((i) => i.id);
        const blockIds = items.filter((i) => i.type === "block").map((i) => i.id);
        const allIds = [...playIds, ...blockIds];
        setExpanded((prev) => {
          const allExpanded = allIds.length > 0 && allIds.every((id) => prev.has(id));
          return allExpanded ? new Set() : new Set(allIds);
        });
      }
      return;
    }

    // -- Host section --
    if (section === "hosts") {
      if (key.upArrow) setHCur((c) => Math.max(0, c - 1));
      if (key.downArrow) setHCur((c) => Math.min(filteredHosts.length - 1, c + 1));
      if (key.pageUp) setHCur((c) => Math.max(0, c - viewH));
      if (key.pageDown) setHCur((c) => Math.min(filteredHosts.length - 1, c + viewH));
      if (input === "a") {
        setHostSel((p) => (allUniqueHosts.size === p.size && [...p].every(h => allUniqueHosts.has(h)) ? new Set() : new Set(allUniqueHosts)));
      }
      if (input === " ") {
        const hi = filteredHosts[safeHCur];
        if (!hi) return;
        setHostSel((prev) => {
          const n = new Set(prev);
          if (hi.kind === "group") {
            const g = hostGroups.find((g) => g.name === hi.name)!;
            const allOn = g.hosts.every((h) => n.has(h));
            g.hosts.forEach((h) => (allOn ? n.delete(h) : n.add(h)));
          } else {
            n.has(hi.name) ? n.delete(hi.name) : n.add(hi.name);
          }
          return n;
        });
      }
      if (key.rightArrow || key.return) {
        const hi = filteredHosts[safeHCur];
        if (hi?.kind === "group") {
          setExpandedGroups((prev) => new Set(prev).add(hi.name));
        }
      }
      if (key.leftArrow) {
        const hi = filteredHosts[safeHCur];
        if (hi?.kind === "group") {
          setExpandedGroups((prev) => { const n = new Set(prev); n.delete(hi.name); return n; });
        }
      }
    }

    // -- Playbook section --
    if (section === "playbook" && filteredVisible.length > 0) {
      if (key.upArrow) setPCur((c) => Math.max(0, c - 1));
      if (key.downArrow) setPCur((c) => Math.min(filteredVisible.length - 1, c + 1));
      if (key.pageUp) setPCur((c) => Math.max(0, c - viewH));
      if (key.pageDown) setPCur((c) => Math.min(filteredVisible.length - 1, c + viewH));
      if (input === " ") {
        const it = filteredVisible[safePCur];
        if (!it) return;
        setTaskSel((prev) => {
          const n = new Set(prev);
          if (it.type === "play") {
            // Toggle ALL tasks in this play (including inside blocks)
            const allTasks = items.filter((i) => i.type === "task" && i.playIndex === it.playIndex);
            const allOn = allTasks.every((k) => n.has(k.id));
            allTasks.forEach((k) => (allOn ? n.delete(k.id) : n.add(k.id)));
            // Update block checkboxes
            items.filter((i) => i.type === "block" && i.playIndex === it.playIndex).forEach((b) => {
              const bKids = items.filter((i) => i.type === "task" && i.parentId === b.id);
              bKids.every((k) => n.has(k.id)) ? n.add(b.id) : n.delete(b.id);
            });
            allOn ? n.delete(it.id) : n.add(it.id);
          } else if (it.type === "block") {
            // Toggle all tasks inside this block
            const bKids = items.filter((i) => i.type === "task" && i.parentId === it.id);
            const allOn = bKids.every((k) => n.has(k.id));
            bKids.forEach((k) => (allOn ? n.delete(k.id) : n.add(k.id)));
            allOn ? n.delete(it.id) : n.add(it.id);
            // Update play checkbox
            const pid = `p${it.playIndex}`;
            const allPlayTasks = items.filter((i) => i.type === "task" && i.playIndex === it.playIndex);
            allPlayTasks.every((s) => n.has(s.id)) ? n.add(pid) : n.delete(pid);
          } else {
            // Toggle single task
            n.has(it.id) ? n.delete(it.id) : n.add(it.id);
            // Update parent block checkbox (if any)
            if (it.parentId) {
              const sibs = items.filter((i) => i.type === "task" && i.parentId === it.parentId);
              sibs.every((s) => n.has(s.id)) ? n.add(it.parentId) : n.delete(it.parentId);
            }
            // Update play checkbox
            const pid = `p${it.playIndex}`;
            const allPlayTasks = items.filter((i) => i.type === "task" && i.playIndex === it.playIndex);
            allPlayTasks.every((s) => n.has(s.id)) ? n.add(pid) : n.delete(pid);
          }
          return n;
        });
      }
      if (key.return || key.rightArrow) {
        const it = filteredVisible[safePCur];
        if (it?.type === "play" || it?.type === "block") {
          setExpanded((prev) => new Set(prev).add(it.id));
        }
      }
      if (key.leftArrow) {
        const it = filteredVisible[safePCur];
        if (it?.type === "play") {
          setExpanded((prev) => { const n = new Set(prev); n.delete(it.id); return n; });
        } else if (it?.type === "block") {
          const isExpanded = expanded.has(it.id);
          if (isExpanded) {
            setExpanded((prev) => { const n = new Set(prev); n.delete(it.id); return n; });
          } else {
            // Jump to parent (play or parent block)
            const target = it.parentId ?? `p${it.playIndex}`;
            const idx = filteredVisible.findIndex((v) => v.id === target);
            if (idx >= 0) setPCur(idx);
          }
        } else if (it?.type === "task") {
          // Jump to parent block or play
          const target = it.parentId ?? `p${it.playIndex}`;
          const idx = filteredVisible.findIndex((v) => v.id === target);
          if (idx >= 0) setPCur(idx);
        }
      }
    }
  });

  // -- Render helpers --
  const hCheck = (hi: HostListItem) => {
    if (hi.kind === "group") {
      const g = hostGroups.find((g) => g.name === hi.name)!;
      const n = g.hosts.filter((h) => hostSel.has(h)).length;
      return n === 0 ? " " : n === g.hosts.length ? "x" : "~";
    }
    return hostSel.has(hi.name) ? "x" : " ";
  };

  const tCheck = (it: FlatItem) => {
    if (it.type === "play") {
      const kids = items.filter((i) => i.type === "task" && i.playIndex === it.playIndex);
      const n = kids.filter((k) => taskSel.has(k.id)).length;
      return n === 0 ? " " : n === kids.length ? "x" : "~";
    }
    if (it.type === "block") {
      const kids = items.filter((i) => i.type === "task" && i.parentId === it.id);
      const n = kids.filter((k) => taskSel.has(k.id)).length;
      return n === 0 ? " " : n === kids.length ? "x" : "~";
    }
    return taskSel.has(it.id) ? "x" : " ";
  };

  // ====== Render: Running / Done ======
  if (phase === "running" || phase === "done") {
    const raw = outputRef.current;
    const outputLines = raw.split("\n").map((line) => {
      // Handle \r (carriage return) — keep only the last segment
      const parts = line.split("\r");
      return parts[parts.length - 1];
    });

    const viewH = rows - 8;
    const totalLines = outputLines.length;
    // Auto-scroll during running, user-controlled in done
    const effectiveScroll = phase === "running"
      ? Math.max(0, totalLines - viewH)
      : Math.max(0, Math.min(outputScroll, Math.max(0, totalLines - viewH)));
    const slice = outputLines.slice(effectiveScroll, effectiveScroll + viewH);

    const spinner = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'][tick % 10];

    return (
      <Box flexDirection="column" padding={1} borderStyle="round" borderColor={phase === "running" ? "yellow" : (runExitCode === 0 ? "green" : "red")}>
        <Box marginBottom={1}>
          <Text bold color={phase === "running" ? "yellow" : (runExitCode === 0 ? "green" : "red")}>
            {phase === "running"
              ? ` ${spinner} Running: ${runCmd}`
              : ` ${runExitCode === 0 ? "✓ Success:" : "✗ Failed:"} ${runCmd} (Exit ${runExitCode})`}
          </Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {slice.map((line, i) => (
            <Text key={effectiveScroll + i}>{line}</Text>
          ))}
        </Box>
        <Box marginTop={1} flexDirection="row" justifyContent="space-between">
          <Text dimColor>
            {totalLines > viewH ? `Lines ${effectiveScroll + 1}–${Math.min(effectiveScroll + viewH, totalLines)} / ${totalLines}` : `Total ${totalLines} lines`}
          </Text>
          <Text dimColor>
            {phase === "done"
              ? " [Enter] Back   [↑↓/PgUp/PgDn] Scroll   [q] Quit"
              : " [q] Cancel"}
          </Text>
        </Box>
      </Box>
    );
  }

  // ====== Render: Select ======
  return (
    <Box flexDirection="column" paddingX={2} paddingY={0} width="100%">
      <Box width="100%" flexDirection="row" gap={2}>
        {/* -- Hosts Panel -- */}
        <Box flexDirection="column" width="35%" borderStyle="round" borderColor={section === "hosts" ? "cyan" : "gray"}>
          <Box paddingX={1} marginBottom={1} flexDirection="row" justifyContent="space-between">
            <Text bold color={section === "hosts" ? "cyan" : "white"}>
              {section === "hosts" ? "❯ " : "  "}Hosts
            </Text>
            <Box flexDirection="row" gap={2}>
              {section === "hosts" && (
                <Text dimColor>
                  <Text bold color="white">[/]</Text>
                </Text>
              )}
              <Text color={selectedHostCount > 0 ? "green" : "gray"} dimColor={selectedHostCount === 0}>
                {selectedHostCount}/{totalHosts} selected
              </Text>
            </Box>
          </Box>
          <Box flexDirection="column" paddingX={1}>
            {searchMode && searchPanel === "hosts" && (
              <Box marginBottom={1}>
                <Text color="cyan">/ {hostSearchQuery}</Text>
              </Box>
            )}
            {hostSlice.length === 0 && hostSearchQuery ? (
              <Text dimColor>No hosts match "{hostSearchQuery}"</Text>
            ) : (
              hostSlice.map((hi, i) => {
                const ri = hScrollStart + i;
                const cur = section === "hosts" && ri === safeHCur;
                const arrow = hi.kind === "group"
                  ? (expandedGroups.has(hi.name) ? "▼ " : "▶ ")
                  : "  ";
                const ind = hi.kind === "host" ? "  " : "";
                const lbl = hi.kind === "group"
                  ? `${hi.name} (${hostGroups.find((g) => g.name === hi.name)!.hosts.filter((h) => hostSel.has(h)).length}/${hostGroups.find((g) => g.name === hi.name)!.hosts.length})`
                  : hi.name;
                return (
                  <Text key={`h${ri}`} color={cur ? "yellow" : undefined} bold={hi.kind === "group"}>
                    {ind}{arrow}[{hCheck(hi)}] {lbl}
                  </Text>
                );
              })
            )}
            {filteredHosts.length > viewH && (
              <Text dimColor>
                ({hScrollStart + 1}–{Math.min(hScrollStart + viewH, filteredHosts.length)}/{filteredHosts.length})
              </Text>
            )}
          </Box>
        </Box>

        {/* -- Playbook Panel -- */}
        <Box flexDirection="column" width="65%" borderStyle="round" borderColor={section === "playbook" ? "cyan" : "gray"}>
          <Box paddingX={1} marginBottom={1} flexDirection="row" justifyContent="space-between">
            <Text bold color={section === "playbook" ? "cyan" : "white"}>
              {section === "playbook" ? "❯ " : "  "}Playbook
            </Text>
            <Box flexDirection="row" gap={2}>
              {section === "playbook" && (
                <Text dimColor>
                  <Text bold color="white">[/]</Text>
                </Text>
              )}
              <Text color={selectedTaskCount > 0 ? "green" : "gray"} dimColor={selectedTaskCount === 0}>
                {selectedTaskCount}/{totalTasks} tasks
              </Text>
            </Box>
          </Box>
          <Box flexDirection="column" paddingX={1}>
            {searchMode && searchPanel === "playbook" && (
              <Box marginBottom={1}>
                <Text color="cyan">/ {playbookSearchQuery}</Text>
              </Box>
            )}
            {pbSlice.length === 0 && playbookSearchQuery ? (
              <Text dimColor>No playbook items match "{playbookSearchQuery}"</Text>
            ) : (
              pbSlice.map((it, vi) => {
                const ri = pScrollStart + vi;
                const cur = section === "playbook" && ri === safePCur;
                const arrow = (it.type === "play" || it.type === "block")
                  ? (expanded.has(it.id) ? "▼ " : "▶ ") : "  ";
                const ind = "  ".repeat(it.depth);
                return (
                  <Box key={it.id}>
                    <Text
                      color={
                        cur ? "yellow"
                        : it.type === "play" ? "cyan"
                        : it.type === "block" ? "white"
                        : undefined
                      }
                      bold={cur || it.type === "play" || it.type === "block"}
                    >
                      {ind}{arrow}[{tCheck(it)}] {it.label}
                    </Text>
                    {it.tags.length > 0 && (
                      <Text color="cyan" dimColor> [{it.tags.join(",")}]</Text>
                    )}
                    {it.hasNever && (
                      <Text color="magenta" dimColor> (never)</Text>
                    )}
                  </Box>
                );
              })
            )}
            {filteredVisible.length > viewH && (
              <Text dimColor>
                ({pScrollStart + 1}–{Math.min(pScrollStart + viewH, filteredVisible.length)}/{filteredVisible.length})
              </Text>
            )}
          </Box>
        </Box>
      </Box>

      {/* -- Command Panel -- */}
      <Box borderStyle="round" borderColor="green" flexDirection="column" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold color="green">Command Preview</Text>
          <Box flexDirection="row" gap={3}>
            {warnMsg && <Text bold color="yellow">{warnMsg}</Text>}
            {!warnMsg && lastResult !== "" && <Text color={lastResult.includes("✓") ? "green" : "red"}>{lastResult}</Text>}
            <Text color={checkFlag ? "yellow" : "gray"}>--check {checkFlag ? "ON" : "off"}</Text>
            <Text color={diffFlag ? "yellow" : "gray"}>--diff {diffFlag ? "ON" : "off"}</Text>
            {!hasTags && hasTaskSelection && hasUntaggedSel && (
              <Text color="yellow">⚠ all non-never tasks will run</Text>
            )}
            {hasTags && hasUntaggedSel && (
              <Text color="yellow">⚠ untagged tasks won't run</Text>
            )}
          </Box>
        </Box>
        <Box marginTop={1} paddingX={1}>
          <Text color={fullCmd.includes("--limit") || fullCmd.includes("--tags") ? "white" : "gray"}>
            {fullCmd || "(select hosts and tasks to preview command)"}
          </Text>
        </Box>
      </Box>

      {/* -- Footer -- */}
      <Box flexDirection="column" marginTop={1} paddingX={1}>
        <Text dimColor>
          <Text bold color="white">[Tab]</Text> Switch Panel   <Text bold color="white">[Space]</Text> Toggle   <Text bold color="white">[a]</Text> All Hosts   <Text bold color="white">[e]</Text> Expand/Collapse All   <Text bold color="white">[→/Enter]</Text> Expand   <Text bold color="white">[←]</Text> Collapse
        </Text>
        <Text dimColor>
          <Text bold color="white">[r]</Text> Run   <Text bold color="white">[c]</Text> --check   <Text bold color="white">[d]</Text> --diff   <Text bold color="white">[s]</Text> Show Cmd   <Text bold color="white">[PgUp/PgDn]</Text> Page   <Text bold color="white">[/]</Text> Search   <Text bold color="white">[Esc]</Text> Clear   <Text bold color="white">[q]</Text> Quit
        </Text>
      </Box>
    </Box>
  );
}

// ===== Entry =====

const INVENTORY_NAMES = ["inventory.yml", "inventory.yaml", "hosts.yml", "hosts.yaml", "hosts", "inventory"];
const PLAYBOOK_NAMES = ["playbook.yml", "playbook.yaml", "site.yml", "site.yaml", "playbooks"];

function findFile(candidates: string[]): string {
  const cwd = process.cwd();
  for (const name of candidates) {
    const basePath = resolve(cwd, name);
    const parentPath = resolve(cwd, "..", name);
    
    if (existsSync(basePath)) return basePath;
    if (existsSync(parentPath)) return parentPath;
  }
  console.error(`Cannot find any of [${candidates.join(", ")}] in . or ..`);
  process.exit(1);
}

const argv = process.argv.slice(2);

// Handle --version / -v flag
if (argv.includes("--version") || argv.includes("-v")) {
  console.log(`ansible-tui v${VERSION}`);
  process.exit(0);
}

const cleanStart = argv.includes("--clean") || argv.includes("-C");
const args = argv.filter((a) => a !== "--clean" && a !== "-C");
const invPath = args[0] ? resolve(args[0]) : findFile(INVENTORY_NAMES);
const pbPath = args[1] ? resolve(args[1]) : findFile(PLAYBOOK_NAMES);

if (!process.stdin.isTTY) {
  console.error("Error: this TUI requires an interactive terminal (TTY).");
  console.error("Run directly: ansible-tui  OR  npx tsx app.tsx");
  process.exit(1);
}

const ansibleDir = dirname(invPath);
const stateFile = resolve(ansibleDir, ".ansible-tui-state.json");
const hostGroups = parseInventory(invPath);
const allItems = parsePlaybook(pbPath);
const initialState = cleanStart ? null : loadState(stateFile);

const { waitUntilExit } = render(
  <App hostGroups={hostGroups} items={allItems} inv={relative(ansibleDir, invPath)} pb={relative(ansibleDir, pbPath)} cwd={ansibleDir}
    initialState={initialState} />,
);

waitUntilExit().then(() => {
  if (currentState) saveState(stateFile, currentState);
  if (showCmd) {
    console.log(`\n${showCmd}\n`);
  }
});
