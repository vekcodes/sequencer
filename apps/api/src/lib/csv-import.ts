import { parse } from 'csv-parse/sync';

// CSV column index → lead field. Special prefix "custom_var:<key>" stores
// the value into the lead's customVariables jsonb under that key.
export type ColumnField =
  | 'email'
  | 'first_name'
  | 'last_name'
  | 'company'
  | 'title'
  | 'phone'
  | 'timezone'
  | `custom_var:${string}`;

export type ColumnMapping = Record<number, ColumnField | null>;

export type ParsedLead = {
  rowIndex: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  title: string | null;
  phone: string | null;
  timezone: string | null;
  customVariables: Record<string, string>;
};

export type RowError = {
  rowIndex: number;
  reason: string;
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseCsvHeaders(csvText: string): string[] {
  // Only the header row is trimmed — body cells preserve whitespace + newlines
  // so multi-line custom-var cells (e.g. pre-written email copy) survive intact.
  const records = parse(csvText, {
    columns: false,
    skip_empty_lines: true,
    trim: true,
    to_line: 1,
    relax_column_count: true,
    relax_quotes: true,
  }) as string[][];
  return (records[0] ?? []).map((h) => (h ?? '').trim());
}

export function parseCsvRows(csvText: string, hasHeader: boolean): string[][] {
  return parse(csvText, {
    columns: false,
    skip_empty_lines: true,
    // trim=false: cells with intentional line breaks (email-copy variables)
    // keep their internal \n and indentation. Per-field trimming is applied
    // selectively in validateAndMap only to identity-style fields.
    trim: false,
    from_line: hasHeader ? 2 : 1,
    relax_column_count: true,
    relax_quotes: true,
  }) as string[][];
}

export type MapResult = {
  valid: ParsedLead[];
  errors: RowError[];
};

export function validateAndMap(
  rows: string[][],
  mapping: ColumnMapping,
): MapResult {
  const valid: ParsedLead[] = [];
  const errors: RowError[] = [];

  // Find which CSV column holds the email
  let emailIdx = -1;
  for (const [colStr, field] of Object.entries(mapping)) {
    if (field === 'email') {
      emailIdx = Number(colStr);
      break;
    }
  }
  if (emailIdx < 0) {
    errors.push({ rowIndex: -1, reason: 'No column mapped to email' });
    return { valid, errors };
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const rawEmail = row[emailIdx];
    const email = (rawEmail ?? '').toLowerCase().trim();

    if (!email) {
      errors.push({ rowIndex: i, reason: 'Missing email' });
      continue;
    }
    if (!EMAIL_REGEX.test(email)) {
      errors.push({ rowIndex: i, reason: `Invalid email: ${email}` });
      continue;
    }

    const parsed: ParsedLead = {
      rowIndex: i,
      email,
      firstName: null,
      lastName: null,
      company: null,
      title: null,
      phone: null,
      timezone: null,
      customVariables: {},
    };

    for (const [colStr, field] of Object.entries(mapping)) {
      if (field === null || field === 'email') continue;
      const colIdx = Number(colStr);
      const raw = row[colIdx] ?? '';

      // Identity-style fields get trimmed; custom_var values keep their
      // original whitespace + line breaks (important for multi-line email
      // copy stored as a custom variable).
      if (field === 'first_name') {
        const v = raw.trim();
        if (v) parsed.firstName = v;
      } else if (field === 'last_name') {
        const v = raw.trim();
        if (v) parsed.lastName = v;
      } else if (field === 'company') {
        const v = raw.trim();
        if (v) parsed.company = v;
      } else if (field === 'title') {
        const v = raw.trim();
        if (v) parsed.title = v;
      } else if (field === 'phone') {
        const v = raw.trim();
        if (v) parsed.phone = v;
      } else if (field === 'timezone') {
        const v = raw.trim();
        if (v) parsed.timezone = v;
      } else if (field.startsWith('custom_var:')) {
        const key = field.slice('custom_var:'.length);
        // Only skip if the cell is entirely empty/whitespace — a cell with
        // "   \n line 1\n line 2  " is meaningful content and should be kept.
        if (key && raw.trim().length > 0) parsed.customVariables[key] = raw;
      }
    }

    valid.push(parsed);
  }

  return { valid, errors };
}
