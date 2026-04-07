import { describe, it, expect, beforeEach } from 'vitest';
import { useTerminalsStore } from '@/stores/terminals-store';

beforeEach(() => {
  useTerminalsStore.setState({ consoles: [], runningTasks: {} });
});

describe('terminals-store running task tracking', () => {
  it('addConsole returns unique ids', () => {
    const id1 = useTerminalsStore.getState().addConsole('a');
    const id2 = useTerminalsStore.getState().addConsole('b');
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).not.toBe(id2);
  });

  it('respects max 4 consoles', () => {
    for (let i = 0; i < 4; i++) {
      expect(useTerminalsStore.getState().addConsole(`t${i}`)).toBeTruthy();
    }
    expect(useTerminalsStore.getState().addConsole('overflow')).toBeNull();
  });

  it('setTerminalRunningTask updates the map', () => {
    const id = useTerminalsStore.getState().addConsole('a')!;
    useTerminalsStore.getState().setTerminalRunningTask(id, {
      actionId: 'a1',
      taskId: 't1',
      label: 'install',
    });
    expect(useTerminalsStore.getState().runningTasks[id]?.label).toBe('install');
  });

  it('clearRunningTaskByTaskId clears matching entries only', () => {
    const id1 = useTerminalsStore.getState().addConsole('a')!;
    const id2 = useTerminalsStore.getState().addConsole('b')!;
    useTerminalsStore.getState().setTerminalRunningTask(id1, {
      actionId: 'a',
      taskId: 't1',
      label: 'one',
    });
    useTerminalsStore.getState().setTerminalRunningTask(id2, {
      actionId: 'a',
      taskId: 't2',
      label: 'two',
    });
    useTerminalsStore.getState().clearRunningTaskByTaskId('t1');
    expect(useTerminalsStore.getState().runningTasks[id1]).toBeNull();
    expect(useTerminalsStore.getState().runningTasks[id2]?.taskId).toBe('t2');
  });

  it('removeConsole also removes its runningTask entry', () => {
    const id = useTerminalsStore.getState().addConsole('a')!;
    useTerminalsStore.getState().setTerminalRunningTask(id, {
      actionId: 'a',
      taskId: 't1',
      label: 'install',
    });
    useTerminalsStore.getState().removeConsole(id);
    expect(useTerminalsStore.getState().runningTasks[id]).toBeUndefined();
    expect(useTerminalsStore.getState().consoles).toHaveLength(0);
  });
});
