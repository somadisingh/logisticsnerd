import './demo-navigation.css';

export function demoNavigation(active: 'workflow' | 'comparison' | 'purchasing' | 'business'): string {
  const pages = [
    { id: 'workflow', href: '/', label: 'Order workflow' },
    { id: 'comparison', href: '/supplier-comparison.html', label: 'Supplier comparison' },
    { id: 'purchasing', href: '/purchasing.html', label: 'Purchasing' },
    { id: 'business', href: '/business.html', label: 'Business setup & records' },
  ];
  return `<nav class="workflow-nav" aria-label="Demos">${pages.map(page =>
    `<a href="${page.href}"${page.id === active ? ' aria-current="page"' : ''}>${page.label}</a>`,
  ).join('')}</nav>`;
}
