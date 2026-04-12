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
  const records = parse(csvText, {
    columns: false,
    skip_empty_lines: true,
    trim: true,
    to_line: 1,
    relax_column_count: true,
    relax_quotes: true,
  }) as string[][];
  return records[0] ?? [];
}

export function parseCsvRows(csvText: string, hasHeader: boolean): string[][] {
  return parse(csvText, {
    columns: false,
    skip_empty_lines: true,
    trim: true,
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
      const raw = row[colIdx];
      const value = (raw ?? '').trim();
      if (!value) continue;

      if (field === 'first_name') parsed.firstName = value;
      else if (field === 'last_name') parsed.lastName = value;
      else if (field === 'company') parsed.company = value;
      else if (field === 'title') parsed.title = value;
      else if (field === 'phone') parsed.phone = value;
      else if (field === 'timezone') parsed.timezone = value;
      else if (field.startsWith('custom_var:')) {
        const key = field.slice('custom_var:'.length);
        if (key) parsed.customVariables[key] = value;
      }
    }

    valid.push(parsed);
  }

  return { valid, errors };
}
