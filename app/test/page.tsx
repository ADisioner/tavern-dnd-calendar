import TableApp from '../table/table-app';
export const dynamic = 'force-dynamic';
export default async function TestPage({ searchParams }: { searchParams: Promise<{ campaign?: string }> }) {
  const params = await searchParams;
  return <TableApp campaignId={params.campaign ?? ''} testMode/>;
}
