-- CreateTable
CREATE TABLE "orders" (
    "id" SERIAL NOT NULL,
    "total" DECIMAL(65,30) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- Grants added by hand after prisma migrate dev --create-only
GRANT SELECT, INSERT ON "orders" TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON "orders" TO service_role;
