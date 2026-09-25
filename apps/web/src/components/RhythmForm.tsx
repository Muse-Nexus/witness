import { useId, useMemo, useState, type FormEvent } from 'react';
import { useApi } from '../api/context';
import type { Rhythm, RhythmSettings, Weekday } from '../api/types';
import { browserTimeZone, formatDate, formatLocalTime } from '../lib/format';

export const WEEKDAYS: { id: Weekday; short: string; long: string }[] = [
  { id: 'mon', short: 'Mon', long: 'Monday' },
  { id: 'tue', short: 'Tue', long: 'Tuesday' },
  { id: 'wed', short: 'Wed', long: 'Wednesday' },
  { id: 'thu', short: 'Thu', long: 'Thursday' },
  { id: 'fri', short: 'Fri', long: 'Friday' },
  { id: 'sat', short: 'Sat', long: 'Saturday' },
  { id: 'sun', short: 'Sun', long: 'Sunday' },
];

export const DEFAULT_TIME = '08:30';

function timeZones(current: string): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = [];
  }
  const all = new Set([current, 'UTC', ...zones]);
  return [...all];
}

export function defaultRhythm(timezone = browserTimeZone()): RhythmSettings {
  return { enabled: false, localTime: DEFAULT_TIME, days: WEEKDAYS.map((d) => d.id), timezone, channel: 'email' };
}

function describeDays(days: Weekday[]): string {
  if (days.length === 7) return 'every day';
  const set = new Set(days);
  if (days.length === 5 && !set.has('sat') && !set.has('sun')) return 'on weekdays';
  if (days.length === 2 && set.has('sat') && set.has('sun')) return 'on weekends';
  return `on ${WEEKDAYS.filter((d) => set.has(d.id)).map((d) => d.long).join(', ')}`;
}

export function describeRhythm(r: Pick<RhythmSettings, 'days' | 'localTime'>): string {
  return `${formatLocalTime(r.localTime)} ${describeDays(r.days)}`;
}

export interface RhythmFormProps {
  initial: Rhythm | undefined;
  email?: string | undefined;
  onSaved?: (rhythm: Rhythm) => void;
  /** Setup shows "Send one now"; Settings shows "Turn off". */
  variant: 'setup' | 'settings';
}

export function RhythmForm({ initial, email, onSaved, variant }: RhythmFormProps) {
  const api = useApi();
  const id = useId();
  const start = initial ?? defaultRhythm();
  const [localTime, setLocalTime] = useState(start.localTime || DEFAULT_TIME);
  const [days, setDays] = useState<Weekday[]>(start.days.length ? start.days : defaultRhythm().days);
  // A rhythm nobody has chosen yet starts in this browser's time zone (SPEC §10), not the
  // account's default (UTC): 7:45 should mean 7:45 where the person is.
  const [timezone, setTimezone] = useState(initial?.consentedAt != null && start.timezone ? start.timezone : browserTimeZone());
  const [enabled, setEnabled] = useState(Boolean(initial?.enabled));
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const zones = useMemo(() => timeZones(timezone), [timezone]);

  const needsConsent = !enabled;

  function toggleDay(day: Weekday) {
    setDays((current) => {
      const chosen = new Set(current);
      if (chosen.has(day)) chosen.delete(day);
      else chosen.add(day);
      // Keep calendar order so the saved list reads mon…sun.
      return WEEKDAYS.map((d) => d.id).filter((d) => chosen.has(d));
    });
  }

  async function save(nextEnabled: boolean) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const payload: RhythmSettings = { enabled: nextEnabled, localTime, days, timezone, channel: 'email' };
      const saved = await api.saveRhythm(payload);
      // Witness sends nothing while nothing is kept, so it does not promise an email before then.
      const keptSomething = nextEnabled ? await api.status().then((s) => s.saved > 0, () => true) : false;
      setEnabled(nextEnabled);
      setConsented(false);
      setMessage(
        !nextEnabled
          ? 'Emails are off. Nothing will be sent.'
          : keptSomething
            ? `Saved. Witness will email you at ${describeRhythm(payload)}.`
            : `Saved. Once Witness keeps something, it will email you at ${describeRhythm(payload)}.`,
      );
      onSaved?.(saved);
    } catch {
      setError('That did not save. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  }

  async function sendNow() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.sendNow();
      if (result.sent) setMessage(`One is on its way${email ? ` to ${email}` : ''}. It can take a minute to arrive.`);
      else if (result.reason === 'send_failed') setError('That did not send. Try again in a moment.');
      else if (result.reason === 'in_progress') setMessage('One is already on its way. It can take a minute to arrive.');
      else if (result.reason === 'all_recent') {
        setMessage('Nothing is ready to send right now. Witness waits a while before sending the same thing again.');
      } else setMessage('Once Witness keeps something, you can send one here. To try it now, add something kind by hand on Home, then come back.');
    } catch {
      setError('That did not send. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (days.length === 0) {
      setError('Choose at least one day.');
      return;
    }
    if (needsConsent && !consented) {
      setError('Check the box above to show you chose this.');
      return;
    }
    void save(true);
  }

  return (
    <form className="rhythm-form" onSubmit={onSubmit} noValidate>
      <div className="rhythm-form__grid">
        <div className="field">
          <label htmlFor={`${id}-time`}>Time</label>
          <input id={`${id}-time`} type="time" value={localTime} required onChange={(e) => setLocalTime(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-zone`}>Time zone</label>
          <select id={`${id}-zone`} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </div>
      </div>

      <fieldset className="field days">
        <legend>Days</legend>
        <div className="days__list">
          {WEEKDAYS.map((day) => (
            <label key={day.id} className="day">
              <input type="checkbox" aria-label={day.long} checked={days.includes(day.id)} onChange={() => toggleDay(day.id)} />
              <span aria-hidden="true">{day.short}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <p className="rhythm-form__channel">
        By email{email ? <> to <strong>{email}</strong></> : null}. Each email holds one thing you kept, in the other
        person's exact words.
      </p>

      {needsConsent ? (
        <label className="consent">
          <input type="checkbox" checked={consented} onChange={(e) => setConsented(e.target.checked)} />
          <span>I'm choosing this now, so Witness can email me on these days.</span>
        </label>
      ) : (
        initial?.consentedAt != null && (
          <p className="rhythm-form__consented">You chose this schedule on {formatDate(initial.consentedAt)}. Change or stop it any time.</p>
        )
      )}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <p className="form-status" role="status">
        {message}
      </p>

      <div className="button-row">
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {enabled ? 'Save changes' : 'Turn on emails'}
        </button>
        {variant === 'setup' && (
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void sendNow()}>
            Send one now to see it
          </button>
        )}
        {variant === 'settings' && enabled && (
          <button type="button" className="btn btn--quiet" disabled={busy} onClick={() => void save(false)}>
            Turn off
          </button>
        )}
      </div>
    </form>
  );
}
