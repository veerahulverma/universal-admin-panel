import type { TemplateDefinition } from '../email/templates.js';

/** Emails the support module sends; registered with the email module so administrators can edit them. */
export const SUPPORT_TEMPLATES: TemplateDefinition[] = [
  {
    key: 'support.ticket_created',
    name: 'Support request received',
    description: 'Confirms to the customer that their support request was received.',
    category: 'transactional',
    subject: '[{{number}}] We received your request: {{subject}}',
    html: `<p>Hi,</p><p>Thanks for contacting {{appName}} support. Your request <strong>{{number}}</strong> has been received and our team will get back to you soon.</p><p style="color:#6b7280;margin-top:20px">Your message:</p><div style="white-space:pre-wrap;border-left:3px solid #e5e7eb;padding:4px 12px;color:#374151">{{body}}</div>`,
    text: `Thanks for contacting {{appName}} support. Your request {{number}} has been received and our team will get back to you soon.\n\nYour message:\n{{body}}`,
    variables: ['number', 'subject', 'body'],
    sampleData: { number: 'T-000042', subject: 'Cannot export my invoices', body: 'Hi, the export button does nothing when I click it.' },
  },
  {
    key: 'support.reply',
    name: 'Support reply',
    description: "Sent to the customer when an agent replies publicly to their ticket (internal notes are never emailed).",
    category: 'transactional',
    subject: 'Re: [{{number}}] {{subject}}',
    html: `<p>Hi,</p>{{#if agentName}}<p>{{agentName}} replied to your request <strong>{{number}}</strong>:</p>{{/if}}<div style="white-space:pre-wrap;border-left:3px solid #e5e7eb;padding:4px 12px;color:#374151">{{body}}</div>{{#if status}}<p style="color:#6b7280;margin-top:20px">Request status: {{status}}</p>{{/if}}`,
    text: `{{#if agentName}}{{agentName}} replied to your request {{number}}:\n\n{{/if}}{{body}}`,
    variables: ['number', 'subject', 'body', 'agentName', 'status'],
    sampleData: { number: 'T-000042', subject: 'Cannot export my invoices', body: 'Thanks for the report. A fix is rolling out today; please try again in an hour.', agentName: 'Sam from Support', status: 'pending' },
  },
];
