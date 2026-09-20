import { pgSchema } from "drizzle-orm/pg-core";

/**
 * tic-campus's schema in tic-auth's database. **A schema, not a database** (F31)
 * — `DATABASE_URL` names `tic_auth`, and the whole arrangement exists so
 * `article.subject_id` can be a real foreign key into `public.subject` rather
 * than an integer somebody keeps in step by hand.
 *
 * Every table this repo owns qualifies through this object, which is what makes
 * "nothing lands in `public`" a property of the code rather than of anyone's
 * care. `public` is not ours to write in: `campus_owner` holds `CREATE` inside
 * this schema and nowhere else, so an unqualified table is not a tidiness
 * problem — it is a migration that cannot apply.
 *
 * The name is a literal, and the only place it is written: `pgSchema()` is read
 * at module load, long before any config exists, and drizzle-kit bakes it into
 * the migrations. An environment variable for it could only ever have agreed
 * with this line or disagreed with the migrations.
 */
export const campus = pgSchema("campus");
