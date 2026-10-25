import { NextResponse } from 'next/server';
import { supabase } from '../../../lib/supabase';
import { formatAddress } from '../../../lib/format';

// Short map link: /m/432 → 302 to Google Maps for family #432's address.
// Kept short so the WhatsApp delivery list stays readable; always resolves
// the family's *current* address at click time.
export async function GET(_request, { params }) {
  const { id } = await params;
  const familyId = parseInt(id, 10);
  if (!Number.isFinite(familyId) || !supabase) {
    return new NextResponse('Not found', { status: 404 });
  }

  const { data } = await supabase
    .from('families')
    .select('address, unit, latitude, longitude')
    .eq('family_id', familyId)
    .single();

  if (!data) return new NextResponse('Not found', { status: 404 });

  let q;
  if (data.address) {
    q = formatAddress(data.address, data.unit);
  } else if (data.latitude != null && data.longitude != null) {
    q = `${data.latitude},${data.longitude}`;
  } else {
    return new NextResponse('No address on file', { status: 404 });
  }

  return NextResponse.redirect(
    `https://maps.google.com/?q=${encodeURIComponent(q)}`,
    302
  );
}
