CREATE INDEX "items_kind_title_idx" ON "items" USING btree ("kind","title","id");--> statement-breakpoint
CREATE INDEX "items_title_trgm_idx" ON "items" USING gin ("title" gin_trgm_ops);