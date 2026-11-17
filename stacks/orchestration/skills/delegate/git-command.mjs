export function parseGitCmd(command, errors, { strict = false } = {}) {
  const config = new Map();
  const valueless = new Set();
  const tokens = [];
  let current = '';
  let started = false;
  let quoted = false;
  for (const character of command) {
    if (character === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && /\s/.test(character)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
    } else {
      current += character;
      started = true;
    }
  }
  if (started) tokens.push(current);
  if (/\{\{[^}]*\}\}/.test(command)) {
    errors.push(`git.cmd carries an unresolved template placeholder: ${command.match(/\{\{[^}]*\}\}/)[0]} — set the identity keys as real values in project config`);
  }
  if (quoted) {
    errors.push('git.cmd has unterminated double quote — a spaced value must be double-quoted or git will word-split it');
    return { config, valueless };
  }
  if (tokens[0] !== 'git') {
    errors.push(`git.cmd must start with "git" (got ${JSON.stringify(tokens[0] ?? '')})`);
    return { config, valueless };
  }
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '-c') {
      const pair = tokens[++index];
      if (pair === undefined) {
        errors.push('git.cmd ends with a dangling -c (no key=value follows)');
        break;
      }
      const separator = pair.indexOf('=');
      const key = (separator === -1 ? pair : pair.slice(0, separator)).toLowerCase();
      config.set(key, separator === -1 ? 'true' : pair.slice(separator + 1));
      if (separator === -1) valueless.add(key);
      else valueless.delete(key);
    } else if (!token.startsWith('-')) {
      errors.push(`git.cmd has a stray word ${JSON.stringify(token)} that is neither "-c" nor a key=value — an unquoted spaced value word-splits here`);
    } else if (strict) {
      errors.push('commit-policy accepts only git and -c key=value options in git.cmd');
    }
  }
  return { config, valueless };
}
