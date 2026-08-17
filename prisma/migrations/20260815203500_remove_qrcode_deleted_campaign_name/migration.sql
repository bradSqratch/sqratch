DO $$
DECLARE
    column_exists BOOLEAN;
    populated BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'QRCode'
          AND column_name = 'deletedCampaignName'
    )
    INTO column_exists;

    IF column_exists THEN
        EXECUTE '
            SELECT EXISTS (
                SELECT 1
                FROM public."QRCode"
                WHERE "deletedCampaignName" IS NOT NULL
            )
        '
        INTO populated;

        IF populated THEN
            RAISE EXCEPTION
                'Refusing to remove QRCode.deletedCampaignName because populated rows exist';
        END IF;

        EXECUTE '
            ALTER TABLE public."QRCode"
            DROP COLUMN "deletedCampaignName"
        ';
    END IF;
END
$$;