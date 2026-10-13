const MODELS = [
  { value: 'claude-fable-5-1', label: 'Fable 5.1' },
  { value: 'claude-opus-5-5', label: 'Opus 5.5' },
  { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { value: 'claude-haiku-5-5', label: 'Haiku 5.5' },
];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const THRESHOLDS = [100_000, 150_000, 200_000, 250_000, 300_000, 400_000, 500_000, 750_000];
const DEFAULTS = { model: 'claude-sonnet-5-5', effort: 'medium', locked: true };
let policy = { ...DEFAULTS };
let context = null;
let rateLimits = [];
let percent = 100;
let pending = false;
let notice = '';

function format(tokens) {
  return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}k`;
}

function windowValue(value) {
  if (value === 'auto') return value;
  const match = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(value.trim());
  if (!match) throw new Error('Choose auto or a window of at least 100k tokens.');
  const tokens = Number(match[1]) * (match[2].toLowerCase() === 'm' ? 1_000_000 : match[2] ? 1000 : 1);
  if (!Number.isSafeInteger(tokens) || tokens < 100_000) {
    throw new Error('The compaction window must be at least 100k tokens.');
  }
  return String(tokens);
}

async function refresh($) {
  await enforce($);
  const usage = await $.session.usage({ breakdown: 'summary' });
  context = usage.context;
  rateLimits = usage.rateLimits;
  const value = Number(await $.env.get('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'));
  percent = Number.isFinite(value) && value > 0 && value <= 100 ? value : 100;
  $.ui.invalidate('ui.render');
}

async function setPercent($, value) {
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error('Choose a compaction percentage from 1 to 100.');
  const enabled = await $.config.set({ key: 'autoCompact', value: true });
  if (enabled.deny) throw new Error(enabled.deny);
  const previous = await $.env.get('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE');
  try {
    await $.env.set('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', String(value));
    await $.store.set('compact-percent', value);
    // One knob: the threshold is a share of the model's full window, so drop any window override.
    await $.env.set('CLAUDE_CODE_AUTO_COMPACT_WINDOW', undefined);
    await $.store.set('compact-window', 'auto');
  } catch (error) {
    await $.env.set('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', previous);
    throw error;
  }
  await refresh($);
}

// Claude-palette nested rings, outermost first: context, 5-hour, weekly.
const RINGS = [
  { r: 36, color: '#D97757' }, // clay
  { r: 27, color: '#E3B062' }, // kraft gold
  { r: 18, color: '#8DB49A' }, // sage
];
const C = 42;
const clamp = value => Math.max(0, Math.min(100, value));
const pct = value => Number.isFinite(value) ? `${Math.round(clamp(value))}%` : '—';

function countdown(at) {
  const ms = new Date(at).getTime() - Date.now();
  if (!Number.isFinite(ms)) return '';
  const m = Math.max(0, Math.round(ms / 60_000)), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d ? `${d}d ${h % 24}h` : h ? `${h}h ${m % 60}m` : `${m}m`;
}

function spark() {
  // Small Claude-style starburst in the middle.
  return Array.from({ length: 8 }, (_, i) => {
    const a = i * Math.PI / 4, l = i % 2 ? 3.5 : 6;
    return `<line x1="${C}" y1="${C}" x2="${(C + Math.cos(a) * l).toFixed(1)}" y2="${(C + Math.sin(a) * l).toFixed(1)}"/>`;
  }).join('');
}

// Hovering a ring shows its percentage in the centre (CSS only; the frame runs no script).
const STYLE = '<style>.t{opacity:0;transition:opacity .15s}.s{transition:opacity .15s}.f{transition:stroke-width .15s}.g:hover .f{stroke-width:9}'
  + RINGS.map((_, i) => `svg:has(.g${i}:hover) .t${i}`).join(',') + '{opacity:1}svg:has(.g:hover) .s{opacity:0}</style>';

function rings({ Box, Text, Svg }, items) {
  const body = items.map(({ label, value, detail }, i) => {
    const { r, color } = RINGS[i];
    const valid = Number.isFinite(value);
    const title = `<title>${label}: ${valid ? `${pct(value)} left` : 'unavailable'}${detail ? ` · ${detail}` : ''}</title>`;
    const track = `<circle cx="${C}" cy="${C}" r="${r}" fill="none" stroke="${color}" stroke-opacity=".16" stroke-width="7"${valid ? '' : ' stroke-dasharray="1 5" stroke-linecap="round"'}/>`;
    const fill = valid && value > 0 ? `<circle class="f" cx="${C}" cy="${C}" r="${r}" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" pathLength="100" stroke-dasharray="${clamp(value).toFixed(1)} 100" transform="rotate(-90 ${C} ${C})"/>` : '';
    return `<g class="g g${i}">${title}${track}${fill}</g>`;
  }).join('');
  const centre = items.map(({ value }, i) => `<text class="t t${i}" x="${C}" y="${C + 5}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="14" font-weight="600" fill="${RINGS[i].color}">${pct(value)}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="84" height="84" viewBox="0 0 84 84">${STYLE}${body}<g class="s" stroke="#D97757" stroke-width="1.6" stroke-linecap="round">${spark()}</g>${centre}</svg>`;
  const alt = items.map(({ label, value, detail }) => `${label}: ${Number.isFinite(value) ? `${pct(value)} remaining` : 'unavailable'}. ${detail}`).join(' ');
  const legend = items.map(({ value, detail }, i) => Box({ flexDirection: 'row', justifyContent: 'flex-end', columnGap: 1, children: [
    Text({ bold: true, color: Number.isFinite(value) && value < 15 ? 'error' : undefined, children: [pct(value)] }),
    ...(detail ? [Text({ dimColor: true, children: [detail] })] : []),
    Text({ color: RINGS[i].color, children: ['●'] }),
  ] }));
  return Box({ flexDirection: 'row', alignItems: 'center', columnGap: 2, children: [
    Box({ flexDirection: 'column', alignItems: 'flex-end', children: legend }),
    Svg ? Svg({ width: 84, height: 84, alt, source: svg, isInteractive: true }) : Text({ children: [alt] }),
  ] });
}

// Claude Code re-applies the env block of settings.json whenever settings reload,
// which would undo the panel. So every turn and every refresh (each 10s) puts the
// panel's choices back: settings.json values never need to be removed by hand.
async function enforce($) {
  // Locked: force every subagent onto the chosen model. Unlocked: drop any pin.
  const model = policy.locked ? policy.model : undefined, force = policy.locked ? '1' : undefined;
  if (await $.env.get('CLAUDE_CODE_SUBAGENT_MODEL') !== model) await $.env.set('CLAUDE_CODE_SUBAGENT_MODEL', model);
  if (await $.env.get('CLAUDE_CODE_SUBAGENT_MODEL_FORCE') !== force) await $.env.set('CLAUDE_CODE_SUBAGENT_MODEL_FORCE', force);
  // Compaction: only once the person has picked something in the panel.
  const saved = await $.store.get('compact-percent');
  const percent = Number.isInteger(saved) && saved >= 1 && saved <= 100 ? String(saved) : undefined;
  if (percent && await $.env.get('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE') !== percent) await $.env.set('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', percent);
  const window = await $.store.get('compact-window');
  if (typeof window === 'string') {
    const value = window === 'auto' ? undefined : window;
    if (await $.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW') !== value) await $.env.set('CLAUDE_CODE_AUTO_COMPACT_WINDOW', value);
  }
}

async function savePolicy($, change) {
  const updated = { ...policy, ...change };
  if (!MODELS.some(({ value }) => value === updated.model) || !EFFORTS.includes(updated.effort) || typeof updated.locked !== 'boolean') {
    throw new Error('Choose a listed model, effort level, and lock state.');
  }
  // Persist before displaying a selection as saved.
  await $.store.set('policy', updated);
  policy = updated;
  await enforce($);
  notice = updated.locked ? 'Subagent lock on.' : 'Subagent lock off.';
  $.ui.invalidate('ui.render');
}

async function compact($, value) {
  if (pending) throw new Error('A compaction change is already queued.');
  const args = value === 'now' ? '' : windowValue(value);
  if (args !== '' && args !== 'auto' && Number(args) > context.window) throw new Error(`This model has a ${format(context.window)} context limit.`);
  pending = true;
  notice = 'Queued.';
  $.ui.invalidate('ui.render');
  try {
    if (value !== 'now') {
      const enabled = await $.config.set({ key: 'autoCompact', value: true });
      if (enabled.deny) throw new Error(enabled.deny);
      const previous = await $.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
      try {
        await $.env.set('CLAUDE_CODE_AUTO_COMPACT_WINDOW', args === 'auto' ? undefined : args);
        await $.store.set('compact-window', args);
      } catch (error) {
        await $.env.set('CLAUDE_CODE_AUTO_COMPACT_WINDOW', previous);
        throw error;
      }
      await refresh($);
      notice = `Window ${args === 'auto' ? 'auto' : format(Number(args))}.`;
    } else {
      const result = await $.command.run({ command: 'compact', args: '' });
      await refresh($);
      notice = result.text || 'Compacted.';
    }
  } finally {
    pending = false;
    $.ui.invalidate('ui.render');
  }
}

async function act($, action) {
  try { await action(); }
  catch (error) {
    notice = `Could not apply: ${error.message || String(error)}`;
    $.ui.toast(notice);
  }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    const saved = await $.store.get('policy');
    if (saved && MODELS.some(({ value }) => value === saved.model) && EFFORTS.includes(saved.effort) && typeof saved.locked === 'boolean') policy = saved;
    await refresh($);
    $.clock.every(10_000, () => refresh($));
    await $.command.register({ name: 'control-panel', description: 'Set compaction/subagent policy; controls stay above the prompt', argumentHint: '[percent 30|compact 300k|compact now|model ID|effort medium|lock on|lock off]', immediate: true });
    return next(e);
  });

  on('command.run', { command: 'control-panel' }, async ($, e) => {
    const [command, value] = e.args.trim().split(/\s+/);
    try {
      if (!command || command === 'show') notice = 'Controls stay above the prompt.';
      else if (command === 'percent') await setPercent($, Number(value));
      else if (command === 'compact') {
        const window = value || 'auto';
        if (window === 'now') {
          $.clock.after(0, () => act($, () => compact($, 'now')));
          return { text: 'Compaction command queued until Claude is idle.' };
        }
        await compact($, window);
      }
      else if (command === 'model') await savePolicy($, { model: value });
      else if (command === 'effort') await savePolicy($, { effort: value });
      else if (command === 'lock' && ['on', 'off'].includes(value)) await savePolicy($, { locked: value === 'on' });
      else throw new Error('Use /control-panel [percent 30|compact 300k|compact now|model ID|effort medium|lock on|lock off].');
      $.ui.invalidate('ui.render');
      return { text: `${notice || 'Controls above the prompt.'}\nSubagents: ${policy.model}, ${policy.effort}, lock ${policy.locked ? 'on' : 'off'}.` };
    } catch (error) { return { text: `Could not apply: ${error.message || String(error)}` }; }
  });

  // Some hosts (the Agent SDK, e.g. T3 Code) apply settings.json env after session.start,
  // so re-assert before each turn too, ahead of any tool or compaction check.
  on('turn.start', async ($, e, next) => {
    await enforce($);
    return next(e);
  });

  on('session.measure', async ($, e, next) => {
    await refresh($);
    return next(e);
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const existing = await next(e);
    if (!context || e.props.hasSurvey) return existing;
    const elements = $.ui.resolve(e);
    const { Box, Text, Button, Select } = elements;
    const row = children => Box({ flexDirection: 'row', alignItems: 'center', columnGap: 1, children });
    // Fixed-width label column keeps both rows' controls on one left edge.
    const setting = (label, children) => row([Box({ width: 9, children: [Text({ dimColor: true, children: [label] })] }), ...children]);
    const trigger = Math.min(Math.round((context.breakdown?.rawMaxTokens ?? context.window) * percent / 100), context.breakdown?.autoCompactThreshold ?? Infinity);
    const used = context.tokens;
    const quota = kind => {
      const limit = rateLimits.find(limit => limit.kind === kind);
      return { label: kind === 'five_hour' ? '5-hour' : 'Weekly', value: limit ? 100 - limit.percentUsed : undefined, detail: limit?.resetsAt ? countdown(limit.resetsAt) : '' };
    };
    const thresholds = [...new Set([...THRESHOLDS.filter(tokens => tokens < context.window), trigger])].sort((a, b) => a - b);
    return Box({ flexDirection: 'column', children: [
      Box({ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 4, rowGap: 1, children: [
        Box({ flexDirection: 'column', rowGap: 1, children: [
          setting('Compact at', [
            Select({ key: 'compact-at', value: String(trigger), options: thresholds.map(tokens => ({ value: String(tokens), label: format(tokens) })), onSelect: value => act($, () => setPercent($, Math.max(1, Math.round(Number(value) / context.window * 100)))) }),
            Button({ key: 'compact-now', label: pending ? 'Compacting…' : 'Compact now', dimColor: pending, onPress: () => act($, () => compact($, 'now')) }),
          ]),
          setting('Subagents', [
            Select({ key: 'subagent-model', value: policy.model, options: MODELS, onSelect: model => act($, () => savePolicy($, { model })) }),
            Select({ key: 'subagent-effort', value: policy.effort, options: EFFORTS.map(value => ({ value, label: value })), onSelect: effort => act($, () => savePolicy($, { effort })) }),
            Button({ key: 'subagent-lock', label: policy.locked ? 'Locked' : 'Unlocked', onPress: () => act($, () => savePolicy($, { locked: !policy.locked })), children: [
              Text({ color: policy.locked ? '#8DB49A' : undefined, dimColor: !policy.locked, children: [policy.locked ? '● ' : '○ '] }),
              Text({ dimColor: !policy.locked, children: [policy.locked ? 'Locked' : 'Unlocked'] }),
            ] }),
          ]),
        ] }),
        rings(elements, [
          { label: 'Context', value: used === undefined ? undefined : Math.max(0, 100 - used / context.window * 100), detail: used === undefined ? '' : used >= trigger ? 'compacting soon' : `${format(trigger - used)} to compact` },
          quota('five_hour'), quota('seven_day'),
        ]),
      ] }),
      existing,
    ] });
  });

  on('agent.spawn', async ($, e, next) => {
    if (!policy.locked) return next(e);
    if (e.fork || e.isTeammate) return { deny: 'Subagent lock is on. Use an ordinary subagent; forks and teammates cannot guarantee the selected model and effort in this process.' };
    return next({ ...e, model: policy.model });
  }).catch(async () => ({ deny: 'Subagent policy failed. Turn the lock off explicitly to continue without it.' }));

  on('turn.step', async function* ($, e, next) {
    if (policy.locked && e.agentId && (await $.agent.list()).some(agent => agent.id === e.agentId)) {
      return yield* next({ ...e, model: policy.model, effort: policy.effort });
    }
    return yield* next(e);
  }).catch(async function* ($, e, next) {
    // Fail closed: a skipped hook would otherwise send an unlocked request.
    if (next.called) return yield* next(e);
    const text = 'Subagent policy could not be checked. No request was sent. Turn the lock off explicitly or reload the plugin.';
    yield { kind: 'text', index: 0, text };
    return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'refusal', usage: null };
  });
}
