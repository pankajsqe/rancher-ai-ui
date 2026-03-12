import MarkdownIt from 'markdown-it';
import {
  ActionType, MessageConfirmationAction, Tag, Context,
  Message,
  Role,
  MessageAction,
  HistoryChatMessage,
  ChatMetadata,
  ConfirmationStatus,
  AgentMetadata,
  AIAgentConfigCRD,
  Agent,
  MessageLabelKey,
  ChatError,
  SourceLinkItem,
} from '../types';
import { validateActionResource } from './validator';

interface WSInputMessageArgs {
  prompt: string;
  agent?: string;
  context?: Context[];
  labels?: Record<MessageLabelKey, string>;
  tags?: string[];
}

const md = new MarkdownIt({
  html:        true,
  breaks:      true,
  linkify:     true,
  typographer: true,
});

const FENCED_CODE_BLOCK_RE = /```[\s\S]*?```/g;
const YAML_KEY_RE = /^\s*[A-Za-z_][\w.-]*\s*:\s*.*$/;
const YAML_LIST_RE = /^\s*-\s+.+$/;
const YAML_DOC_MARKER_RE = /^\s*(---|\.\.\.)\s*$/;
const YAML_K8S_KEY_RE = /^\s*(apiVersion|kind|metadata|spec|stringData|data|labels|annotations|containers|env|image|name|namespace)\s*:/;

function looksLikeYamlParagraph(paragraph: string): boolean {
  const lines = paragraph
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim().length > 0);

  if (lines.length < 2) {
    return false;
  }

  const keyLines = lines.filter((line) => YAML_KEY_RE.test(line));
  const listLines = lines.filter((line) => YAML_LIST_RE.test(line));
  const hasK8sKey = lines.some((line) => YAML_K8S_KEY_RE.test(line));
  const hasDocMarker = lines.some((line) => YAML_DOC_MARKER_RE.test(line));
  const hasIndentedStructure = lines.some((line) => /^\s{2,}[A-Za-z_][\w.-]*\s*:/.test(line) || /^\s{2,}-\s+/.test(line));

  if (hasK8sKey && keyLines.length >= 2) {
    return true;
  }

  if (hasDocMarker && keyLines.length >= 1) {
    return true;
  }

  return keyLines.length >= 3 && (hasIndentedStructure || listLines.length >= 1);
}

function normalizeYamlInTextSegment(segment: string): string {
  const parts = segment.split(/(\n\s*\n)/);

  return parts.map((part, index) => {
    if (index % 2 === 1) {
      return part;
    }

    const trimmed = part.trim();

    if (!trimmed || !looksLikeYamlParagraph(trimmed)) {
      return part;
    }

    const trailingNewline = part.endsWith('\n') ? '\n' : '';

    return `\`\`\`yaml\n${ trimmed }\n\`\`\`${ trailingNewline }`;
  }).join('');
}

function normalizeYamlMarkdown(message: string): string {
  if (!message) {
    return message;
  }

  const chunks: string[] = [];
  let lastIndex = 0;

  for (const match of message.matchAll(FENCED_CODE_BLOCK_RE)) {
    const matchIndex = match.index ?? 0;

    chunks.push(normalizeYamlInTextSegment(message.slice(lastIndex, matchIndex)));
    chunks.push(match[0]);
    lastIndex = matchIndex + match[0].length;
  }

  chunks.push(normalizeYamlInTextSegment(message.slice(lastIndex)));

  return chunks.join('');
}

export function formatMessageContent(message: string) {
  const raw = md.render(normalizeYamlMarkdown(message ?? ''));

  // remove trailing <br> tags and trailing whitespace/newlines
  return raw.replace(/(?:(?:<br\s*\/?>)|\r?\n|\s)+$/gi, '');
}

export function formatWSInputMessage(args: WSInputMessageArgs): string {
  const context = (args.context || []).reduce((acc, ctx) => ({
    ...acc,
    [ctx.tag]: ctx.value
  }), {});

  const tags = args.tags?.length ? args.tags : undefined;

  return JSON.stringify({
    prompt: args.prompt,
    agent:  args.agent,
    context,
    labels: args.labels,
    tags,
  });
}

export function formatChatErrorMessage(data: string): ChatError {
  const cleaned = data.replaceAll(Tag.ChatErrorStart, '').replaceAll(Tag.ChatErrorEnd, '').trim();

  if (cleaned) {
    try {
      const parsed = JSON.parse(cleaned);

      return parsed;
    } catch (e) {
      console.error('Failed to parse chat error message:', e); /* eslint-disable-line no-console */
    }
  }

  return { message: 'An error occurred.' };
}

export function formatChatMetadata(data: string): ChatMetadata | null {
  if (data.startsWith(Tag.ChatMetadataStart) && data.endsWith(Tag.ChatMetadataEnd)) {
    const cleaned = data.replaceAll(Tag.ChatMetadataStart, '').replaceAll(Tag.ChatMetadataEnd, '').trim();

    try {
      return JSON.parse(cleaned);
    } catch (error) {
      console.error('Failed to parse chat metadata:', error); /* eslint-disable-line no-console */
    }
  }

  return null;
}

export function formatAgentFromCRD(config: AIAgentConfigCRD): Agent {
  return {
    name:        config.metadata.name,
    displayName: config.spec.displayName,
    description: config.spec.description,
    status:      config.state || 'unknown',
  };
}

export function formatAgentMetadata(data: string, agents: Agent[]): AgentMetadata | null {
  const cleaned = data.replaceAll(Tag.AgentMetadataStart, '').replaceAll(Tag.AgentMetadataEnd, '').trim();

  try {
    const rawMetadata = JSON.parse(cleaned);

    if (rawMetadata) {
      const { agentName, selectionMode, recommended } = rawMetadata;

      const agent = agents.find((a) => a.name === agentName);

      if (agent) {
        return {
          agent,
          selectionMode,
          recommended,
        };
      }
    }
  } catch (error) {
    console.error('Failed to parse agent metadata:', error); /* eslint-disable-line no-console */
  }

  return null;
}

export function formatMessageRelatedResourcesActions(value: string, actionType = ActionType.Button): MessageAction[] {
  value = value.replaceAll(Tag.McpResultStart, '').replaceAll(Tag.McpResultEnd, '').trim();

  if (value) {
    try {
      const parsed = JSON.parse(value);

      if (Array.isArray(parsed)) {
        return parsed.flatMap((item) => formatMessageRelatedResourcesActions(JSON.stringify(item), actionType));
      }

      if (!validateActionResource(parsed)) {
        return [];
      }

      const names = Array.isArray(parsed.name) ? parsed.name : [parsed.name];

      return names.map((name: string) => ({
        type:     actionType,
        label:    `View ${ parsed.kind }: ${ name }`,
        resource: {
          kind:      parsed.kind,
          type:      parsed.type,
          name,
          namespace: parsed.namespace,
          cluster:   parsed.cluster,
        },
      }));
    } catch (e) {
      console.error('Failed to parse MCP response:', e); /* eslint-disable-line no-console */
    }
  }

  return [];
}

export function formatConfirmationActions(value: string): MessageConfirmationAction[] | null {
  value = value.replaceAll(Tag.ConfirmationStart, '').replaceAll(Tag.ConfirmationEnd, '').trim();

  if (value) {
    try {
      const parsed = JSON.parse(value);

      return parsed;
    } catch (e) {
      console.error('Failed to parse confirmation response:', e); /* eslint-disable-line no-console */
    }
  }

  return null;
}

export function formatSuggestionActions(suggestionActions: string[], remaining: string): { suggestionActions: string[]; remaining: string } {
  const re = /<suggestion\b[^>]*>([\s\S]*?)<\/suggestion>/i;
  const match = remaining?.match(re);

  if (match) {
    const inner = match[1]; // first suggestion text

    suggestionActions.push(inner.trim());
    remaining = remaining.replace(match[0], '').trim();

    if (remaining) {
      return formatSuggestionActions(suggestionActions, remaining);
    }
  }

  return {
    suggestionActions,
    remaining
  };
}

export function formatFileMessages(principal: any, messages: Message[]): string {
  const avatar = {
    [Role.User]:      `👤 ${ principal?.name || 'user' }`,
    [Role.Assistant]: '🤖 Liz',
    [Role.System]:    '🛠️ Liz',
  };

  return (messages || []).map((msg) => {
    const timestamp = msg.timestamp?.toLocaleTimeString([], {
      hour:   '2-digit',
      minute: '2-digit'
    });

    let body = msg.summaryContent ? `Summary: ${ msg.summaryContent }\n` : '';

    body += msg.templateContent?.content?.message ? `${ msg.templateContent.content.message }\n` : '';
    body += msg.messageContent ? `${ msg.messageContent }\n` : '';
    body += msg.thinkingContent ? `${ msg.thinkingContent }\n` : '';

    if (msg.contextContent?.length) {
      body += `Context: ${ JSON.stringify(msg.contextContent) }\n`;
    }

    if (msg.suggestionActions?.length) {
      body += `Suggestions: [${ msg.suggestionActions.join('], [') }]\n`;
    }

    return `[${ timestamp }] [${ avatar[msg.role] }]: ${ body }`;
  }).join('\n');
}

export function formatSourceLinks(links: SourceLinkItem[], value: string): SourceLinkItem[] {
  const cleanedLink = value.replaceAll(Tag.DocLinkStart, '').replaceAll(Tag.DocLinkEnd, '').trim();

  return [
    ...links,
    cleanedLink
  ];
}

export function formatErrorMessage(value: string): ChatError {
  value = value.replaceAll(Tag.ErrorStart, '').replaceAll(Tag.ErrorEnd, '').trim();

  if (value) {
    try {
      const parsed = JSON.parse(value);

      return parsed;
    } catch (e) {
      console.error('Failed to parse error message:', e); /* eslint-disable-line no-console */
    }
  }

  return { message: 'An error occurred.' };
}

export function buildMessageFromHistoryMessage(msg: HistoryChatMessage, agents: Agent[]): Message {
  /**
   * Parsing agent metadata
   */
  let agentMetadata = undefined;

  if (msg.agent?.name) {
    const { name, mode: selectionMode } = msg.agent;

    const agent = agents.find((a) => a.name === name) || {
      name,
      displayName: name,
      description: 'Unknown agent',
    };

    agentMetadata = {
      agent,
      selectionMode,
    };
  }

  /**
   * Parsing context
   */
  const contextData = (msg.context || {}) as Record<string, any>;

  const contextContent: Context[] = Object.keys(contextData).map((key) => ({
    value:       contextData[key],
    tag:         key,
    description:   key,
  }));

  /**
   * Parsing suggestion actions
   */
  let suggestionActions: string[] = [];

  if (msg.message?.includes(Tag.SuggestionsStart) && msg.message?.includes(Tag.SuggestionsEnd)) {
    const { suggestionActions: suggestionActionsData, remaining } = formatSuggestionActions(suggestionActions, msg.message);

    suggestionActions = suggestionActionsData;
    msg.message = remaining;
  }

  /**
   * Parsing related resources actions
   */
  let relatedResourcesActions: MessageAction[] = [];

  if (msg.message?.startsWith(Tag.McpResultStart) && msg.message?.includes(Tag.McpResultEnd)) {
    const mcpPart = msg.message.substring(
      msg.message.indexOf(Tag.McpResultStart),
      msg.message.indexOf(Tag.McpResultEnd) + Tag.McpResultEnd.length
    );

    const remaining = msg.message.replace(mcpPart, '').trim();

    relatedResourcesActions = formatMessageRelatedResourcesActions(mcpPart);
    msg.message = remaining;
  }

  /**
   * Parsing confirmation action
   */
  let confirmation = undefined;

  if (msg.message.startsWith(Tag.ConfirmationStart) && msg.message.endsWith(Tag.ConfirmationEnd) && msg.confirmation !== undefined) {
    const confirmationActions = formatConfirmationActions(msg.message);

    if (confirmationActions) {
      confirmation = {
        actions: confirmationActions,
        status:  msg.confirmation ? ConfirmationStatus.Confirmed : ConfirmationStatus.Canceled,
      };
      msg.message = '';
    }
  }

  /**
   * Parsing source links
   */
  let sourceLinks: SourceLinkItem[] = [];

  while (msg.message?.includes(Tag.DocLinkStart) && msg.message?.includes(Tag.DocLinkEnd)) {
    const linkPart = msg.message.substring(
      msg.message.indexOf(Tag.DocLinkStart),
      msg.message.indexOf(Tag.DocLinkEnd) + Tag.DocLinkEnd.length
    );

    sourceLinks = formatSourceLinks(sourceLinks, linkPart);
    msg.message = msg.message.replace(linkPart, '').trim();
  }

  /**
   * Parsing thinking content
   */
  let thinkingContent = '';

  if (msg.message?.startsWith(Tag.ThinkingStart) && msg.message?.includes(Tag.ThinkingEnd)) {
    const thinkingPart = msg.message.substring(
      msg.message.indexOf(Tag.ThinkingStart),
      msg.message.indexOf(Tag.ThinkingEnd) + Tag.ThinkingEnd.length
    );

    thinkingContent = thinkingPart
      .replaceAll(Tag.ThinkingStart, '')
      .replaceAll(Tag.ThinkingEnd, '')
      .trim();

    const remaining = msg.message.replace(thinkingPart, '').trim();

    msg.message = remaining;
  }

  /**
   * Parsing summary content
   */
  const summaryContent = msg.labels?.[MessageLabelKey.Summary] || undefined;

  return {
    role:              msg.role === 'agent' ? Role.Assistant : Role.User,
    completed:         true,
    thinking:          false,
    showThinking:      false,
    agentMetadata,
    thinkingContent,
    contextContent,
    summaryContent,
    relatedResourcesActions,
    confirmation,
    suggestionActions,
    sourceLinks,
    messageContent:    msg.message,
    timestamp:         new Date(msg.createdAt),
  };
}
