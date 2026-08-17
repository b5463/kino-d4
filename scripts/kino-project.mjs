#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const OWNER = 'b5463';
const REPOSITORY = 'kino-d4';
const PROJECT_NUMBER = 3;
const PROJECT_URL = 'https://github.com/users/b5463/projects/3';

const FIELD_FLAGS = new Map([
  ['status', 'Status'],
  ['priority', 'Priority'],
  ['area', 'Area'],
  ['target', 'Target'],
]);

function gh(args) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.error) {
    throw new Error(`Could not run GitHub CLI: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    throw new Error(detail);
  }

  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function graphql(query, variables = {}) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    if (value === undefined || value === null) continue;
    args.push(typeof value === 'number' || typeof value === 'boolean' ? '-F' : '-f');
    args.push(`${name}=${value}`);
  }
  return gh(args).data;
}

function projectMeta() {
  const query = `
    query($login: String!, $number: Int!) {
      user(login: $login) {
        projectV2(number: $number) {
          id
          title
          url
          fields(first: 50) {
            nodes {
              ... on ProjectV2SingleSelectField {
                id
                name
                options { id name }
              }
            }
          }
        }
      }
    }
  `;
  const project = graphql(query, { login: OWNER, number: PROJECT_NUMBER }).user.projectV2;
  if (!project) throw new Error(`Project not found: ${PROJECT_URL}`);
  return project;
}

function projectItems() {
  const query = `
    query($login: String!, $number: Int!, $after: String) {
      user(login: $login) {
        projectV2(number: $number) {
          items(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              content {
                __typename
                ... on Issue { number title url state }
                ... on PullRequest { number title url state }
                ... on DraftIssue { title }
              }
              fieldValues(first: 30) {
                nodes {
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    name
                    field { ... on ProjectV2FieldCommon { name } }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const items = [];
  let after;
  do {
    const page = graphql(query, { login: OWNER, number: PROJECT_NUMBER, after })
      .user.projectV2.items;
    items.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : undefined;
  } while (after);
  return items;
}

function itemFields(item) {
  return Object.fromEntries(
    item.fieldValues.nodes
      .filter((value) => value.field?.name)
      .map((value) => [value.field.name, value.name]),
  );
}

function listItems() {
  const rows = projectItems()
    .filter((item) => item.content?.__typename === 'Issue')
    .sort((a, b) => a.content.number - b.content.number)
    .map((item) => ({ ...item.content, ...itemFields(item) }));

  console.log(`KINO D4 project: ${PROJECT_URL}`);
  console.log('ISSUE  STATUS       PRIORITY  AREA       TARGET');
  for (const row of rows) {
    console.log(
      `#${String(row.number).padEnd(5)} ` +
      `${String(row.Status ?? '-').padEnd(12)} ` +
      `${String(row.Priority ?? '-').padEnd(9)} ` +
      `${String(row.Area ?? '-').padEnd(10)} ` +
      `${row.Target ?? '-'}`,
    );
    console.log(`       ${row.title}`);
  }
}

function issueNode(issueNumber) {
  const query = `
    query($owner: String!, $repo: String!, $issue: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $issue) { id number title url }
      }
    }
  `;
  const issue = graphql(query, { owner: OWNER, repo: REPOSITORY, issue: issueNumber })
    .repository.issue;
  if (!issue) throw new Error(`Issue #${issueNumber} does not exist in ${OWNER}/${REPOSITORY}.`);
  return issue;
}

function addIssue(project, issueNumber) {
  const existing = projectItems().find(
    (item) => item.content?.__typename === 'Issue' && item.content.number === issueNumber,
  );
  if (existing) return existing;

  const issue = issueNode(issueNumber);
  const mutation = `
    mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
        item { id }
      }
    }
  `;
  const item = graphql(mutation, { projectId: project.id, contentId: issue.id })
    .addProjectV2ItemById.item;
  return { ...item, content: issue, fieldValues: { nodes: [] } };
}

function parseFlags(tokens) {
  const values = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      throw new Error(`Expected --field value, received: ${tokens.slice(index).join(' ')}`);
    }
    const key = flag.slice(2).toLowerCase();
    if (!FIELD_FLAGS.has(key)) throw new Error(`Unknown field: ${flag}`);
    values[FIELD_FLAGS.get(key)] = value;
  }
  return values;
}

function selectField(project, fieldName, optionName) {
  const field = project.fields.nodes.find((candidate) => candidate?.name === fieldName);
  if (!field) throw new Error(`Project field not found: ${fieldName}`);
  const option = field.options.find(
    (candidate) => candidate.name.toLowerCase() === optionName.toLowerCase(),
  );
  if (!option) {
    throw new Error(
      `${fieldName} does not have '${optionName}'. Choose: ${field.options.map((item) => item.name).join(', ')}`,
    );
  }
  return { fieldId: field.id, optionId: option.id, optionName: option.name };
}

function setFields(project, item, values) {
  const mutation = `
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { singleSelectOptionId: $optionId }
      }) { projectV2Item { id } }
    }
  `;

  for (const [fieldName, requestedOption] of Object.entries(values)) {
    const selected = selectField(project, fieldName, requestedOption);
    graphql(mutation, {
      projectId: project.id,
      itemId: item.id,
      fieldId: selected.fieldId,
      optionId: selected.optionId,
    });
    console.log(`${fieldName}: ${selected.optionName}`);
  }
}

function usage() {
  console.log(`Usage:
  npm run project -- list
  npm run project -- add <issue> --priority P1 --area Hardware --target D4-V1
  npm run project -- set <issue> [--status "In Progress"] [--priority P1] [--area Hardware] [--target D4-V1]
  npm run project -- start <issue>
  npm run project -- done <issue>`);
}

function issueNumber(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Invalid issue number: ${value}`);
  return parsed;
}

function main() {
  const [command = 'help', issueArgument, ...tokens] = process.argv.slice(2);
  if (command === 'help' || command === '--help' || command === '-h') return usage();
  if (command === 'list') return listItems();

  const number = issueNumber(issueArgument);
  const project = projectMeta();
  const item = addIssue(project, number);

  if (command === 'add') {
    const values = { Status: 'Todo', ...parseFlags(tokens) };
    for (const required of ['Priority', 'Area', 'Target']) {
      if (!values[required]) throw new Error(`add requires --${required.toLowerCase()}.`);
    }
    setFields(project, item, values);
  } else if (command === 'set') {
    const values = parseFlags(tokens);
    if (Object.keys(values).length === 0) throw new Error('set requires at least one field.');
    setFields(project, item, values);
  } else if (command === 'start') {
    setFields(project, item, { Status: 'In Progress' });
  } else if (command === 'done') {
    setFields(project, item, { Status: 'Done' });
  } else {
    throw new Error(`Unknown command: ${command}`);
  }

  console.log(`#${number}: ${item.content.title}`);
  console.log(PROJECT_URL);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  if (/scope|project|oauth/i.test(error.message)) {
    console.error('GitHub CLI needs project access: gh auth refresh -h github.com -s project');
  }
  process.exitCode = 1;
}
