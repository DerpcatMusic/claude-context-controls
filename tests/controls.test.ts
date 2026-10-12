import { expect, test, mock } from 'claude-code/testing';

const POLICY = { model: 'claude-sonnet-5-5', effort: 'medium', locked: true };
const START = { cwd: '/work', surface: 'terminal' as const, isInteractive: true };
const SPAWN = {
  tool_use_id: 'tool-1', prompt: 'Check the code', description: 'Review',
  subagentType: 'Explore', model: 'claude-opus-5-5', parentModel: 'claude-opus-5-5',
  provider: { plugin: 'engine', tier: 'core' as const }, background: true, fork: false,
};
const STEP = { turnId: 'turn-1', index: 0, model: 'claude-opus-5-5', effort: 'high' as const, messageCount: 1 };
const BAND = { component: 'AbovePrompt' as const, requestId: 'band', props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 110 } };

function setup(on, stored = POLICY, capacity = 1_000_000, rateLimits = [{ kind: 'five_hour', percentUsed: 25, resetsAt: new Date(Date.now() + 125.4 * 60_000).toISOString() }, { kind: 'seven_day', percentUsed: 60 }]) {
  mock.store(on, { policy: stored });
  let window = capacity;
  let source = 'model-default';
  const env = new Map([['CLAUDE_CODE_AUTO_COMPACT_WINDOW', String(capacity)], ['CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', '30']]);
  on('env.get', ($, e) => ({ value: env.get(e.name) }));
  on('env.set', ($, e) => {
    if (e.value === undefined) env.delete(e.name); else env.set(e.name, e.value);
    if (e.name === 'CLAUDE_CODE_AUTO_COMPACT_WINDOW') {
      window = e.value === undefined ? capacity : Math.min(capacity, Number(e.value));
      source = e.value === undefined ? 'model-default' : 'env';
    }
    return { value: undefined };
  });
  let compactCalls = 0;
  on('session.start', () => ({ cwd: '/work' }));
  on('command.register', () => ({ value: undefined }));
  on('config.set', ($, e) => ({ value: e.value }));
  on('session.usage', () => ({ value: { context: { tokens: 184_000, window: capacity, percent: 18, breakdown: {
    categories: [{ name: 'Autocompact buffer', kind: 'buffer', tokens: 33_000, color: 'inactive', isDeferred: false }], autoCompactThreshold: window - 33_000, totalTokens: 184_000, maxTokens: window, rawMaxTokens: window,
    autocompactSource: source, percentage: 18, gridRows: [], model: 'claude-opus-5-5',
    memoryFiles: [], mcpTools: [], agents: [], isAutoCompactEnabled: true, apiUsage: null,
  } }, rateLimits } }));
  on('command.run', ($, e) => {
    if (e.command === 'autocompact') { window = e.args === 'auto' ? 1_000_000 : Number(e.args); source = e.args === 'auto' ? 'model-default' : 'settings'; }
    if (e.command === 'compact') compactCalls++;
    return { text: 'Applied' };
  });
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['Other mod'] }));
  return { compacts: () => compactCalls, env };
}

async function drain(stream) {
  let step = await stream.next();
  while (!step.done) step = await stream.next();
  return step.value;
}

test('always-on controls, native limits, quota rings, threshold choice and persistence', async ($, on) => {
  const { compacts, env } = setup(on);
  const clock = mock.clock(on);
  await $.session.start(START);
  for (const surface of ['terminal', 'desktop'] as const) {
    await $.command.run({ command: 'control-panel', args: 'compact 1M' });
    await $.command.run({ command: 'control-panel', args: 'percent 30' });
    const ui = await $.ui.mount({ plugin: 'context-controls', surface, ...BAND });
    expect(await ui.find({ type: 'Text', text: '116k to compact' })).toBeDefined();
    expect(await ui.find({ type: 'Text', text: '2h 5m' })).toBeDefined();
    expect((await ui.find({ key: 'compact-at' }))?.props.value).toBe('300000');
    if (surface === 'desktop') {
      const rings = await ui.findAll({ type: 'Svg' });
      expect(rings.length).toBe(1);
      expect(rings[0].props.alt).toContain('5-hour: 75% remaining');
      expect(rings[0].props.alt).toContain('Weekly: 40% remaining');
    }
    await ui.select({ key: 'compact-at', value: '150000' });
    expect(env.get('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE')).toBe('15');
    expect((await ui.find({ key: 'compact-at' }))?.props.value).toBe('150000');
    expect(await ui.find({ type: 'Text', text: 'Other mod' })).toBeDefined();
    // The threshold is the only knob: it clears any window override.
    expect(env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW')).toBeUndefined();
    await ui.press({ key: 'compact-now' });
    await ui.select({ key: 'subagent-model', value: 'claude-opus-5-5' });
    expect(env.get('CLAUDE_CODE_SUBAGENT_MODEL')).toBe('claude-opus-5-5');
    await ui.select({ key: 'subagent-effort', value: 'low' });
    expect((await ui.find({ key: 'subagent-effort' }))?.props.value).toBe('low');
    await ui.press({ key: 'subagent-lock' });
    expect((await ui.find({ key: 'subagent-lock' }))?.text).toBe('○ Unlocked');
    expect(env.get('CLAUDE_CODE_SUBAGENT_MODEL')).toBeUndefined();
    await ui.press({ key: 'subagent-lock' });
    await $.session.start(START);
    expect(env.get('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE')).toBe('15');
    expect((await ui.find({ key: 'subagent-model' }))?.props.value).toBe('claude-opus-5-5');
    await $.command.run({ command: 'control-panel', args: 'hide' });
    expect(await ui.find({ key: 'compact-now' })).toBeDefined();
    await ui.unmount();
  }
  expect(compacts()).toBe(2);
  const invalid = await $.command.run({ command: 'control-panel', args: 'compact 10k' });
  expect(invalid.text).toContain('at least 100k');
  const custom = await $.command.run({ command: 'control-panel', args: 'compact 350k' });
  expect(custom.text).toContain('350k');
  await clock.advance(0);
});

test('the model capacity caps choices and missing account readings are unavailable', async ($, on) => {
  setup(on, POLICY, 200_000, []);
  await $.session.start(START);
  const ui = await $.ui.mount({ plugin: 'context-controls', surface: 'desktop', ...BAND });
  const rings = await ui.findAll({ type: 'Svg' });
  expect(rings[0].props.alt).toContain('5-hour: unavailable');
  expect(rings[0].props.alt).toContain('Weekly: unavailable');
  expect((await $.command.run({ command: 'control-panel', args: 'compact 1M' })).text).toContain('200k context limit');
  await ui.unmount();
});

test('model and effort are enforced for nested and resumed agents, not the main or internal loops', async ($, on) => {
  setup(on);
  const seen = [];
  let spawn;
  on('agent.list', () => ({ value: [{ id: 'agent-1', type: 'Explore', status: 'running', description: 'Review' }] }));
  on('agent.spawn', ($, e) => { spawn = e; return { model: e.model, agentId: 'agent-1' }; });
  on('turn.step', async function* ($, e) {
    seen.push(e);
    yield { kind: 'text', index: 0, text: 'ok' };
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null };
  });
  await $.session.start(START);
  await $.agent.spawn(SPAWN);
  expect(spawn.model).toBe('claude-sonnet-5-5');
  expect(spawn.subagentType).toBe('Explore');
  await $.agent.spawn({ ...SPAWN, parentAgentId: 'agent-1' });
  expect(spawn.model).toBe('claude-sonnet-5-5');
  expect((await $.agent.spawn({ ...SPAWN, fork: true })).deny).toContain('lock is on');
  expect((await $.agent.spawn({ ...SPAWN, isTeammate: true })).deny).toContain('lock is on');
  await drain($.turn.step({ ...STEP, agentId: 'agent-1' }));
  expect(seen[0].model).toBe('claude-sonnet-5-5');
  expect(seen[0].effort).toBe('medium');
  await drain($.turn.step(STEP));
  expect(seen[1].model).toBe(STEP.model);
  expect(seen[1].effort).toBe('high');
  await drain($.turn.step({ ...STEP, agentId: 'internal-compaction' }));
  expect(seen[2].model).toBe(STEP.model);
  await $.command.run({ command: 'control-panel', args: 'effort low' });
  await drain($.turn.step({ ...STEP, agentId: 'agent-1', index: 1 }));
  expect(seen[3].effort).toBe('low');
  await $.command.run({ command: 'control-panel', args: 'lock off' });
  await $.agent.spawn({ ...SPAWN, fork: true });
  expect(spawn.fork).toBe(true);
  await drain($.turn.step({ ...STEP, agentId: 'agent-1' }));
  expect(seen[4].model).toBe(STEP.model);
});

test('a failed policy check refuses the request instead of silently bypassing the lock', async ($, on) => {
  setup(on);
  let requests = 0;
  on('agent.list', () => { throw new Error('unavailable'); });
  on('turn.step', async function* ($, e) {
    requests++;
    return { turnId: e.turnId, index: e.index, answer: 'bad', toolUses: [], stopReason: 'end_turn', usage: null };
  });
  await $.session.start(START);
  const result = await drain($.turn.step({ ...STEP, agentId: 'agent-1' }));
  expect(requests).toBe(0);
  expect(result.answer).toContain('No request was sent');
});
