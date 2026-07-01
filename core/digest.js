#!/usr/bin/env node
// Daily per-project digest. Reads ~/.claude/session-data/*.tmp,
// groups by project, writes rolling activity.md into each ~/projects/<name>/memory/activity/daily.md
// and a global rollup at ~/.claude/projects/-root/memory/daily-rollup.md.
//
//
// Usage:
//   node daily-project-digest.js               # real run
//   node daily-project-digest.js --dry-run     # show what would be written
//   node daily-project-digest.js --project X   # limit to one project (useful for testing)

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SESSIONS_DIR = (process.env.MEMKIT_CLAUDE_DIR||(process.env.HOME||'/root')+'/.claude')+'/session-data';
const PROCESSED_DIR = (process.env.MEMKIT_CLAUDE_DIR||(process.env.HOME||'/root')+'/.claude')+'/session-data/processed';
const PROJECTS_DIR = (process.env.MEMKIT_PROJECTS_DIR||(process.env.HOME||'/root')+'/projects');
const PROJECT_ROOTS = [PROJECTS_DIR];
const HOMELESS_DAILY = (process.env.MEMKIT_ROOT_MEM||(process.env.HOME||'/root')+'/.claude/projects/-root/memory')+'/activity/daily.md';
const ROUTING_JSON = (process.env.MEMKIT_TG_ROUTING||(process.env.HOME||'/root')+'/.claude/channels/telegram/routing.json');
const WINDOW_DAYS_PROJECT = 30;
const WINDOW_DAYS_ROLLUP = 14;

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const LIMIT_PROJECT = (() => {
    const i = args.indexOf("--project");
    return i >= 0 ? args[i + 1] : null;
})();

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

function parseFilename(name) {
    // YYYY-MM-DD-<project>-session.tmp
    const m = name.match(/^(\d{4}-\d{2}-\d{2})-(.+)-session\.tmp$/);
    if (!m) return null;
    return { date: m[1], projectFromFilename: m[2] };
}

function extractSection(body, header) {
    // Parse markdown sections like "### Tasks" until next "### " or end
    const re = new RegExp(`^###\\s+${header}\\s*$`, "m");
    const m = re.exec(body);
    if (!m) return [];
    const rest = body.slice(m.index + m[0].length);
    const end = rest.search(/^###\s+/m);
    const block = end >= 0 ? rest.slice(0, end) : rest;
    return block
        .split("\n")
        .map((l) => l.replace(/^-\s*/, "").trim())
        .filter((l) => l.length > 0);
}

function extractHeader(body, key) {
    const re = new RegExp(`^\\*\\*${key}:\\*\\*\\s*(.+)$`, "m");
    const m = re.exec(body);
    return m ? m[1].trim() : null;
}

function parseSession(filePath) {
    const name = path.basename(filePath);
    const fn = parseFilename(name);
    if (!fn) return null;
    const body = fs.readFileSync(filePath, "utf8");
    const headerProject = extractHeader(body, "Project");
    const lastUpdated = extractHeader(body, "Last Updated");
    const started = extractHeader(body, "Started");
    const project = headerProject || fn.projectFromFilename;
    const summaryMatch = body.match(/<!-- ECC:SUMMARY:START -->([\s\S]*?)<!-- ECC:SUMMARY:END -->/);
    const summary = summaryMatch ? summaryMatch[1] : "";
    const rawTasks = extractSection(summary, "Tasks");
    const tasks = rawTasks;
    const thread = dominantThread(rawTasks);
    const threadProject = thread && TOPIC_MAP[thread] ? TOPIC_MAP[thread] : null;
    const files = extractSection(summary, "Files Modified");
    const tools = extractSection(summary, "Tools Used");
    return {
        date: fn.date,
        project,
        started,
        lastUpdated,
        tasks,
        files,
        tools,
        threadProject,
        _filename: name,
    };
}

function normalizeTask(t) {
    if (t.startsWith("<channel")) {
        const m = t.match(/source="([^"]+)"/);
        const src = m ? m[1].split(":").pop() : "channel";
        return `[${src}] входящее сообщение`;
    }
    if (t.startsWith("<task-notification") || t.startsWith("<tool-use-") || t.startsWith("<output-file>")) {
        return null; // drop entirely
    }
    return t.replace(/\s+/g, " ").slice(0, 200);
}

function dedupe(arr) {
    const seen = new Set();
    const out = [];
    for (const x of arr) {
        if (!seen.has(x)) {
            seen.add(x);
            out.push(x);
        }
    }
    return out;
}

function formatSessionEntry(s) {
    const tasks = dedupe(s.tasks.map(normalizeTask).filter(Boolean)).slice(0, 8);
    const files = dedupe(s.files).slice(0, 10);
    const tools = dedupe(s.tools).join(", ");
    const lines = [];
    const timeRange = s.started ? ` (${s.started}–${s.lastUpdated || "?"})` : "";
    lines.push(`## ${s.date} — ${s.project}${timeRange}`);
    if (tasks.length) {
        lines.push("**Tasks:**");
        for (const t of tasks) lines.push(`- ${t}`);
    }
    if (files.length) {
        lines.push(`**Files modified (${s.files.length}):**`);
        for (const f of files) lines.push(`- ${f}`);
    }
    if (tools) lines.push(`**Tools:** ${tools}`);
    lines.push("");
    return lines.join("\n");
}

function dedupeBlocks(content) {
    // Collapse blocks that share an identical "## YYYY-MM-DD — project (...)" header.
    // Key = the full header line. Keep the first occurrence, drop later duplicates.
    const parts = content.split(/(?=^## \d{4}-\d{2}-\d{2})/m);
    const seen = new Set();
    const kept = [];
    for (const p of parts) {
        const m = p.match(/^(## \d{4}-\d{2}-\d{2}[^\n]*)/);
        if (!m) {
            kept.push(p); // preamble/header (only the leading chunk lacks a "## date")
            continue;
        }
        const key = m[1].trim();
        if (seen.has(key)) continue;
        seen.add(key);
        kept.push(p);
    }
    return kept.join("");
}

function trimToLastDays(existingContent, windowDays) {
    // Find ## YYYY-MM-DD sections, keep only the most recent windowDays
    const parts = existingContent.split(/(?=^## \d{4}-\d{2}-\d{2})/m);
    const kept = [];
    const today = new Date();
    for (const p of parts) {
        const m = p.match(/^## (\d{4}-\d{2}-\d{2})/);
        if (!m) {
            if (kept.length === 0) kept.push(p); // preamble/header
            continue;
        }
        const d = new Date(m[1]);
        const ageDays = (today - d) / 86400000;
        if (ageDays <= windowDays) kept.push(p);
    }
    return kept.join("").trimEnd() + "\n";
}

function loadRouting() {
    try {
        const d = JSON.parse(fs.readFileSync(ROUTING_JSON, "utf8"));
        const map = {};
        for (const [thread, t] of Object.entries(d.topics || {})) {
            const dir = (t.project_dir || "").replace(/\/+$/, "");
            if (dir) map[thread] = path.basename(dir);
        }
        return map;
    } catch { return {}; }
}
const TOPIC_MAP = loadRouting();

function dominantThread(rawTasks) {
    // Доминирующий message_thread_id из сырых channel-тегов сессии.
    const counts = {};
    for (const t of rawTasks) {
        const m = String(t).match(/message_thread_id="(\d+)"/);
        if (m) counts[m[1]] = (counts[m[1]] || 0) + 1;
    }
    let best = null, bestN = 0;
    for (const [th, n] of Object.entries(counts)) if (n > bestN) { best = th; bestN = n; }
    return best;
}

function resolveProjectRoot(project) {
    for (const root of PROJECT_ROOTS) {
        const candidate = path.join(root, project);
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

function writeProjectDigest(project, entries) {
    const projectRoot = resolveProjectRoot(project);
    if (!projectRoot) {
        log(`skip project '${project}' — not found in ${PROJECT_ROOTS.join(", ")}`);
        return null;
    }
    const dir = path.join(projectRoot, "memory", "activity");
    const file = path.join(dir, "daily.md");
    if (DRY_RUN) {
        log(`[dry-run] would write ${entries.length} entries to ${file}`);
        return file;
    }
    fs.mkdirSync(dir, { recursive: true });
    const header = `# Recent activity — последние ${WINDOW_DAYS_PROJECT} дней (auto, не редактировать руками)\n\n`;
    let existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : header;
    if (!existing.startsWith("#")) existing = header + existing;
    const newBlock = entries.map(formatSessionEntry).join("\n");
    const headerEnd = existing.indexOf("\n\n") + 2;
    const preserved = existing.slice(headerEnd);
    const merged = existing.slice(0, headerEnd) + newBlock + "\n" + preserved;
    const deduped = dedupeBlocks(merged);
    const trimmed = trimToLastDays(deduped, WINDOW_DAYS_PROJECT);
    fs.writeFileSync(file, trimmed);
    log(`wrote ${entries.length} entries to ${file}`);
    return file;
}

function writeHomelessDigest(entries) {
    // Сессии вне ~/projects (работа в /root, /tmp, разовые темы) — общий буфер
    // для тематической переработки в ~/.claude/projects/-root/memory/topics/.
    if (!entries.length) { log("no homeless sessions"); return; }
    if (DRY_RUN) { log(`[dry-run] would write ${entries.length} homeless entries to ${HOMELESS_DAILY}`); return; }
    fs.mkdirSync(path.dirname(HOMELESS_DAILY), { recursive: true });
    const header = `# Recent activity — бездомные сессии (вне ~/projects), последние ${WINDOW_DAYS_PROJECT} дней (auto)\n\n`;
    let existing = fs.existsSync(HOMELESS_DAILY) ? fs.readFileSync(HOMELESS_DAILY, "utf8") : header;
    if (!existing.startsWith("#")) existing = header + existing;
    entries.sort((a, b) => b.date.localeCompare(a.date));
    const newBlock = entries.map(formatSessionEntry).join("\n");
    const headerEnd = existing.indexOf("\n\n") + 2;
    const merged = existing.slice(0, headerEnd) + newBlock + "\n" + existing.slice(headerEnd);
    const trimmed = trimToLastDays(dedupeBlocks(merged), WINDOW_DAYS_PROJECT);
    fs.writeFileSync(HOMELESS_DAILY, trimmed);
    log(`wrote ${entries.length} homeless entries to ${HOMELESS_DAILY}`);
}
function todayMSK() {
    // Current date in Europe/Moscow as YYYY-MM-DD (matches tmp filename prefix).
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: (process.env.MEMKIT_TZ||(process.env.MEMKIT_TZ||'Europe/Moscow')),
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(new Date());
}

function archiveProcessedTmp() {
    // Move processed *.tmp into PROCESSED_DIR. NEVER touch today's tmp (MSK) —
    // live sessions are still appending to those. Archive yesterday and older only.
    const today = todayMSK();
    let moved = 0;
    let skipped = 0;
    fs.mkdirSync(PROCESSED_DIR, { recursive: true });
    for (const name of fs.readdirSync(SESSIONS_DIR)) {
        if (!name.endsWith(".tmp")) continue;
        const fn = parseFilename(name);
        if (!fn) continue; // not a session tmp — leave it alone
        if (fn.date >= today) {
            skipped++;
            continue; // today (or future) — still being written to
        }
        const from = path.join(SESSIONS_DIR, name);
        const to = path.join(PROCESSED_DIR, name);
        try {
            fs.renameSync(from, to);
            moved++;
        } catch (e) {
            log(`archive: failed to move ${name}: ${e.message}`);
        }
    }
    log(`archived ${moved} tmp to ${PROCESSED_DIR}, kept ${skipped} current (today=${today})`);
}

function main() {
    log(`daily-project-digest start (dry-run=${DRY_RUN}, limit=${LIMIT_PROJECT || "*"})`);
    if (!fs.existsSync(SESSIONS_DIR)) {
        log(`no sessions dir: ${SESSIONS_DIR}`);
        process.exit(0);
    }

    const sessions = [];
    for (const name of fs.readdirSync(SESSIONS_DIR)) {
        if (!name.endsWith(".tmp")) continue;
        let s;
        try {
            s = parseSession(path.join(SESSIONS_DIR, name));
        } catch (e) {
            log(`skip ${name}: ${e.message}`);
            continue;
        }
        if (!s) continue;
        if (s.tasks.length === 0 && s.files.length === 0) continue;
        if (LIMIT_PROJECT && s.project !== LIMIT_PROJECT) continue;
        sessions.push(s);
    }
    log(`parsed ${sessions.length} non-empty sessions`);

    const byProject = {};
    for (const s of sessions) {
        // Telegram topic-routing: если сессия из проектного топика — относим по топику, а не по cwd.
        const proj = (s.threadProject && s.threadProject !== "root") ? s.threadProject : s.project;
        (byProject[proj] ||= []).push(s);
    }
    for (const project of Object.keys(byProject)) {
        byProject[project].sort((a, b) => b.date.localeCompare(a.date));
    }

    const homeless = [];
    for (const [project, entries] of Object.entries(byProject)) {
        if (resolveProjectRoot(project)) {
            writeProjectDigest(project, entries);
        } else {
            for (const e of entries) homeless.push(e); // вне ~/projects → общий контур
        }
    }
    writeHomelessDigest(homeless);

    // Archive processed tmp so they are not re-read every run (root cause of dup blocks).
    // Only on a real, full run — never in dry-run, never when limited to one project.
    if (!DRY_RUN && !LIMIT_PROJECT) {
        archiveProcessedTmp();
    } else if (DRY_RUN) {
        log("[dry-run] would archive yesterday-and-older tmp to " + PROCESSED_DIR);
    }

    log("daily-project-digest done");
}

try {
    main();
} catch (e) {
    console.error(`[${new Date().toISOString()}] FATAL:`, e.stack || e);
    process.exit(1);
}
