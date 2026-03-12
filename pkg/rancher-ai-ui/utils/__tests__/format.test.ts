import { describe, it, expect } from '@jest/globals';
import { formatMessageContent } from '../format';

describe('formatMessageContent', () => {
  it('wraps unfenced yaml into a yaml code block', () => {
    const content = `Manifest:\n\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: demo\n  namespace: default\ndata:\n  key: value`;

    const result = formatMessageContent(content);

    expect(result).toContain('<pre><code class="language-yaml">');
    expect(result).toContain('apiVersion: v1');
    expect(result).toContain('kind: ConfigMap');
  });

  it('keeps already fenced yaml unchanged', () => {
    const content = `Manifest:\n\n\`\`\`yaml\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: demo\n\`\`\``;

    const result = formatMessageContent(content);
    const yamlBlocks = result.match(/language-yaml/g) || [];

    expect(yamlBlocks).toHaveLength(1);
  });

  it('does not convert normal prose', () => {
    const content = 'Summary: Deployment healthy\nReason: No restart spikes';

    const result = formatMessageContent(content);

    expect(result).not.toContain('language-yaml');
  });
});
