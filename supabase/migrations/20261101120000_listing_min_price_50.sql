alter table public.listings drop constraint listings_price_range;
alter table public.listings add constraint listings_price_range check (price_amount between 50 and 500000);
