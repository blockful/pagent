import { basicCatalog } from '@a2ui/lit/v0_9';

export function buildShowcaseSpec() {
  const catalogId = basicCatalog.id;
  const components = [
    {
      id: 'root',
      component: 'Column',
      children: [
        'title',
        'subtitle',
        'card-btn',
        'card-tf',
        'card-cb',
        'card-cp',
        'card-tabs',
        'card-dt',
        'card-modal',
        'card-typo',
        'card-divider',
      ],
    },
    { id: 'title', component: 'Text', text: 'Component Showcase', variant: 'h1' },
    {
      id: 'subtitle',
      component: 'Text',
      text: 'All basic catalog components styled with the shadcn design system.',
      variant: 'caption',
    },

    // -- Buttons --
    { id: 'card-btn', component: 'Card', child: 'btn-col' },
    {
      id: 'btn-col',
      component: 'Column',
      children: ['btn-title', 'btn-desc', 'btn-row1', 'btn-row2'],
    },
    { id: 'btn-title', component: 'Text', text: 'Button', variant: 'h3' },
    {
      id: 'btn-desc',
      component: 'Text',
      text: 'Three variants: primary, default (outline), and borderless (ghost).',
      variant: 'caption',
    },
    {
      id: 'btn-row1',
      component: 'Row',
      align: 'center',
      children: ['btn-primary', 'btn-default', 'btn-ghost'],
    },
    { id: 'btn-primary', component: 'Button', child: 'btn-primary-txt', variant: 'primary' },
    { id: 'btn-primary-txt', component: 'Text', text: 'Primary', variant: 'body' },
    { id: 'btn-default', component: 'Button', child: 'btn-default-txt', variant: 'default' },
    { id: 'btn-default-txt', component: 'Text', text: 'Default', variant: 'body' },
    { id: 'btn-ghost', component: 'Button', child: 'btn-ghost-txt', variant: 'borderless' },
    { id: 'btn-ghost-txt', component: 'Text', text: 'Ghost', variant: 'body' },
    { id: 'btn-row2', component: 'Row', align: 'center', children: ['btn-disabled', 'btn-icon'] },
    {
      id: 'btn-disabled',
      component: 'Button',
      child: 'btn-disabled-txt',
      variant: 'primary',
      isValid: false,
    },
    { id: 'btn-disabled-txt', component: 'Text', text: 'Disabled', variant: 'body' },
    { id: 'btn-icon', component: 'Button', child: 'btn-icon-row', variant: 'default' },
    {
      id: 'btn-icon-row',
      component: 'Row',
      align: 'center',
      children: ['btn-icon-ic', 'btn-icon-txt'],
    },
    { id: 'btn-icon-ic', component: 'Icon', icon: 'mail' },
    { id: 'btn-icon-txt', component: 'Text', text: 'With Icon', variant: 'body' },

    // -- TextField --
    { id: 'card-tf', component: 'Card', child: 'tf-col' },
    {
      id: 'tf-col',
      component: 'Column',
      children: ['tf-title', 'tf-desc', 'tf-email', 'tf-pw', 'tf-num', 'tf-long', 'tf-err'],
    },
    { id: 'tf-title', component: 'Text', text: 'TextField', variant: 'h3' },
    {
      id: 'tf-desc',
      component: 'Text',
      text: 'Text, number, password, and long text (textarea) variants.',
      variant: 'caption',
    },
    { id: 'tf-email', component: 'TextField', label: 'Email', value: '', variant: 'text' },
    { id: 'tf-pw', component: 'TextField', label: 'Password', value: '', variant: 'obscured' },
    { id: 'tf-num', component: 'TextField', label: 'Amount', value: '42', variant: 'number' },
    { id: 'tf-long', component: 'TextField', label: 'Description', value: '', variant: 'longText' },
    {
      id: 'tf-err',
      component: 'TextField',
      label: 'With error',
      value: 'bad',
      variant: 'text',
      isValid: false,
      validationErrors: ['This field has an error.'],
    },

    // -- CheckBox & Slider --
    { id: 'card-cb', component: 'Card', child: 'cb-col' },
    {
      id: 'cb-col',
      component: 'Column',
      children: [
        'cb-title',
        'cb-terms',
        'cb-news',
        'cb-invalid',
        'cb-div',
        'sl-bright',
        'sl-opacity',
      ],
    },
    { id: 'cb-title', component: 'Text', text: 'CheckBox & Slider', variant: 'h3' },
    { id: 'cb-terms', component: 'CheckBox', label: 'Accept terms and conditions', value: false },
    { id: 'cb-news', component: 'CheckBox', label: 'Subscribe to newsletter', value: true },
    {
      id: 'cb-invalid',
      component: 'CheckBox',
      label: 'Invalid checkbox',
      value: false,
      isValid: false,
      validationErrors: ['Required'],
    },
    { id: 'cb-div', component: 'Divider', axis: 'horizontal' },
    { id: 'sl-bright', component: 'Slider', label: 'Brightness', value: 75, min: 0, max: 100 },
    { id: 'sl-opacity', component: 'Slider', label: 'Opacity', value: 30, min: 0, max: 100 },

    // -- ChoicePicker --
    { id: 'card-cp', component: 'Card', child: 'cp-col' },
    {
      id: 'cp-col',
      component: 'Column',
      children: ['cp-title', 'cp-desc', 'cp-chips', 'cp-radios', 'cp-multi'],
    },
    { id: 'cp-title', component: 'Text', text: 'ChoicePicker', variant: 'h3' },
    {
      id: 'cp-desc',
      component: 'Text',
      text: 'Single and multi selection with chip and radio display styles.',
      variant: 'caption',
    },
    {
      id: 'cp-chips',
      component: 'ChoicePicker',
      label: 'Framework (chips)',
      variant: 'singleSelection',
      displayStyle: 'chips',
      options: [
        { label: 'React', value: 'react' },
        { label: 'Vue', value: 'vue' },
        { label: 'Svelte', value: 'svelte' },
        { label: 'Lit', value: 'lit' },
      ],
      value: ['lit'],
    },
    {
      id: 'cp-radios',
      component: 'ChoicePicker',
      label: 'Notification preference (radios)',
      variant: 'singleSelection',
      displayStyle: 'default',
      options: [
        { label: 'All', value: 'all' },
        { label: 'Mentions only', value: 'mentions' },
        { label: 'None', value: 'none' },
      ],
      value: ['mentions'],
    },
    {
      id: 'cp-multi',
      component: 'ChoicePicker',
      label: 'Features (multi, chips)',
      variant: 'multipleSelection',
      displayStyle: 'chips',
      options: [
        { label: 'Dark mode', value: 'dark' },
        { label: 'Animations', value: 'anim' },
        { label: 'Sounds', value: 'sound' },
      ],
      value: ['dark', 'anim'],
    },

    // -- Tabs --
    { id: 'card-tabs', component: 'Card', child: 'tabs-col' },
    { id: 'tabs-col', component: 'Column', children: ['tabs-title', 'tabs-main'] },
    { id: 'tabs-title', component: 'Text', text: 'Tabs', variant: 'h3' },
    {
      id: 'tabs-main',
      component: 'Tabs',
      tabs: [
        { title: 'Account', child: 'tab-acct' },
        { title: 'Password', child: 'tab-pw' },
        { title: 'Notifications', child: 'tab-notif' },
      ],
    },
    { id: 'tab-acct', component: 'Column', children: ['tab-acct-desc', 'tab-acct-name'] },
    {
      id: 'tab-acct-desc',
      component: 'Text',
      text: 'Manage your account settings and preferences.',
      variant: 'body',
    },
    {
      id: 'tab-acct-name',
      component: 'TextField',
      label: 'Display name',
      value: 'Alice',
      variant: 'text',
    },
    { id: 'tab-pw', component: 'Column', children: ['tab-pw-desc', 'tab-pw-cur', 'tab-pw-new'] },
    { id: 'tab-pw-desc', component: 'Text', text: 'Change your password here.', variant: 'body' },
    {
      id: 'tab-pw-cur',
      component: 'TextField',
      label: 'Current password',
      value: '',
      variant: 'obscured',
    },
    {
      id: 'tab-pw-new',
      component: 'TextField',
      label: 'New password',
      value: '',
      variant: 'obscured',
    },
    { id: 'tab-notif', component: 'Column', children: ['tab-notif-email', 'tab-notif-push'] },
    { id: 'tab-notif-email', component: 'CheckBox', label: 'Email notifications', value: true },
    { id: 'tab-notif-push', component: 'CheckBox', label: 'Push notifications', value: false },

    // -- DateTimeInput --
    { id: 'card-dt', component: 'Card', child: 'dt-col' },
    { id: 'dt-col', component: 'Column', children: ['dt-title', 'dt-date', 'dt-time', 'dt-both'] },
    { id: 'dt-title', component: 'Text', text: 'DateTimeInput', variant: 'h3' },
    {
      id: 'dt-date',
      component: 'DateTimeInput',
      label: 'Date only',
      enableDate: true,
      enableTime: false,
    },
    {
      id: 'dt-time',
      component: 'DateTimeInput',
      label: 'Time only',
      enableDate: false,
      enableTime: true,
    },
    {
      id: 'dt-both',
      component: 'DateTimeInput',
      label: 'Date & Time',
      enableDate: true,
      enableTime: true,
    },

    // -- Modal --
    { id: 'card-modal', component: 'Card', child: 'modal-col' },
    { id: 'modal-col', component: 'Column', children: ['modal-title', 'modal-desc', 'modal-main'] },
    { id: 'modal-title', component: 'Text', text: 'Modal', variant: 'h3' },
    {
      id: 'modal-desc',
      component: 'Text',
      text: 'Click the button below to open a dialog.',
      variant: 'caption',
    },
    { id: 'modal-main', component: 'Modal', trigger: 'modal-trigger', content: 'modal-content' },
    { id: 'modal-trigger', component: 'Button', child: 'modal-trigger-txt', variant: 'default' },
    { id: 'modal-trigger-txt', component: 'Text', text: 'Open Modal', variant: 'body' },
    {
      id: 'modal-content',
      component: 'Column',
      children: ['modal-dlg-title', 'modal-dlg-body', 'modal-dlg-field'],
    },
    { id: 'modal-dlg-title', component: 'Text', text: 'Dialog Title', variant: 'h3' },
    {
      id: 'modal-dlg-body',
      component: 'Text',
      text: 'This is an example dialog with some content inside it.',
      variant: 'body',
    },
    {
      id: 'modal-dlg-field',
      component: 'TextField',
      label: 'Your name',
      value: '',
      variant: 'text',
    },

    // -- Typography --
    { id: 'card-typo', component: 'Card', child: 'typo-col' },
    {
      id: 'typo-col',
      component: 'Column',
      children: [
        'typo-title',
        'typo-h1',
        'typo-h2',
        'typo-h3',
        'typo-h4',
        'typo-h5',
        'typo-body',
        'typo-caption',
      ],
    },
    { id: 'typo-title', component: 'Text', text: 'Typography', variant: 'h3' },
    { id: 'typo-h1', component: 'Text', text: 'Heading 1', variant: 'h1' },
    { id: 'typo-h2', component: 'Text', text: 'Heading 2', variant: 'h2' },
    { id: 'typo-h3', component: 'Text', text: 'Heading 3', variant: 'h3' },
    { id: 'typo-h4', component: 'Text', text: 'Heading 4', variant: 'h4' },
    { id: 'typo-h5', component: 'Text', text: 'Heading 5', variant: 'h5' },
    {
      id: 'typo-body',
      component: 'Text',
      text: 'Body text renders as a paragraph. It should have comfortable line height and good readability across different screen sizes.',
      variant: 'body',
    },
    {
      id: 'typo-caption',
      component: 'Text',
      text: 'Caption text is smaller and muted — great for descriptions and help text.',
      variant: 'caption',
    },

    // -- Divider --
    { id: 'card-divider', component: 'Card', child: 'div-col' },
    {
      id: 'div-col',
      component: 'Column',
      children: ['div-title', 'div-above', 'div-line', 'div-below'],
    },
    { id: 'div-title', component: 'Text', text: 'Divider', variant: 'h3' },
    { id: 'div-above', component: 'Text', text: 'Content above the divider.', variant: 'body' },
    { id: 'div-line', component: 'Divider', axis: 'horizontal' },
    { id: 'div-below', component: 'Text', text: 'Content below the divider.', variant: 'body' },
  ];

  const V = 'v0.9' as const;
  return [
    { version: V, createSurface: { surfaceId: 'showcase', catalogId } },
    { version: V, updateComponents: { surfaceId: 'showcase', components } },
  ];
}
