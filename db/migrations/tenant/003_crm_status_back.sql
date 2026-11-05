-- A visit cancelled (or No-show) in the CRM cancels the AI's booking too,
-- and a visit restored in the CRM is booked again for the AI.

CREATE OR REPLACE FUNCTION ai_booking_follows_crm() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE ai_bookings
     SET status = CASE WHEN NEW.status IN ('Cancelled', 'No-show') THEN 'cancelled' ELSE 'booked' END
   WHERE crm_appointment_id = NEW.appointment_id
     AND status IS DISTINCT FROM CASE WHEN NEW.status IN ('Cancelled', 'No-show') THEN 'cancelled' ELSE 'booked' END;
  RETURN NULL;
END;
$$;

CREATE TRIGGER ai_booking_follows_crm
  AFTER UPDATE OF status ON appointments
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION ai_booking_follows_crm();

-- Bookings already cancelled in the CRM before this migration.
UPDATE ai_bookings b
   SET status = 'cancelled'
  FROM appointments a
 WHERE a.appointment_id = b.crm_appointment_id
   AND a.status IN ('Cancelled', 'No-show')
   AND b.status = 'booked';