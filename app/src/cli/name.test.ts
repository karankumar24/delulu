// A handoff's name: cleaned from what the saving agent wrote, found again in the handoff's title.
import { describe, it, expect } from 'vitest';
import { handoffName, nameInTitle, takeName } from './name';

describe('handoff names', () => {
  it('turns what the agent wrote into a short name, and nothing usable into nothing', () => {
    expect(handoffName('Ladder fix: live check!')).toBe('ladder-fix-live-check');
    expect(handoffName('one two three four five six seven')).toBe('one-two-three-four-five');
    expect(handoffName('  --- ')).toBe('');
    expect(handoffName('--list')).toBe('list');
  });

  it('takes the name line from the first lines of the note only, in the forms agents write it', () => {
    expect(takeName('name: ladder fix\n\nWhere things stand: done.')).toEqual({ name: 'ladder-fix', rest: 'Where things stand: done.' });
    expect(takeName('# Session\n- **Name:** camera limb swap\nbody').name).toBe('camera-limb-swap');
    expect(takeName('a\nb\nc\nd\ne\nname: too late').name).toBe('');
    expect(takeName('No name here.')).toEqual({ name: '', rest: 'No name here.' });
  });

  it('reads the name back from a title, and none from a title saved before names', () => {
    expect(nameInTitle('# ladder-fix · my app handoff · saved Mon Sep 21, 2026\nTranscript: x')).toBe('ladder-fix');
    expect(nameInTitle('# projectprevious handoff · saved Mon Sep 21, 2026 at 1:16 AM')).toBeUndefined();
    expect(nameInTitle('# my app handoff · saved Mon Sep 21, 2026')).toBeUndefined();
  });
});
