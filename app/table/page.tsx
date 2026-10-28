import TableApp from './table-app';
export const dynamic = 'force-dynamic';
export default async function TablePage({ searchParams }: { searchParams: Promise<{ campaign?: string }> }) {
  const params = await searchParams;
  return <TableApp campaignId={params.campaign ?? ''}/>;
}
