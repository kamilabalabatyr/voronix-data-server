// R2: the test suite drops and recreates its database, so it must refuse any
// database that is not clearly a local test database.
import { describe, expect, it } from "vitest";
import { assertSafeTestDatabase } from "./helpers.js";

describe("test database guard", () => {
  it("refuses a local database whose name does not end with _test", () => {
    expect(() => assertSafeTestDatabase("postgresql://crm:crm@localhost:5432/my_important_db")).toThrow(/Refusing to drop database "my_important_db"/);
    expect(() => assertSafeTestDatabase("postgresql://crm:crm@localhost:5432/crm")).toThrow(/Refusing/);
  });

  it("refuses a remote database even if its name ends with _test", () => {
    expect(() => assertSafeTestDatabase("postgresql://u:p@dpg-example.oregon-postgres.render.com/voronix_test")).toThrow(/host "dpg-example/);
  });

  it("accepts the local test database", () => {
    expect(() => assertSafeTestDatabase("postgresql://crm:crm@localhost:5432/voronix_data_test")).not.toThrow();
    expect(() => assertSafeTestDatabase("postgresql://crm:crm@127.0.0.1:5432/voronix_data_test")).not.toThrow();
  });
});
