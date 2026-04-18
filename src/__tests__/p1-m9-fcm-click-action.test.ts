/**
 * P1-M9 — FCM payload must not carry the legacy Flutter click-action.
 *
 * Background: both Weelo mobile apps (customer + captain) are native Kotlin.
 * Android routes notification taps via `setContentIntent(PendingIntent)`; the
 * `click_action` FCM field is only honored when the receiving Activity declares
 * a matching manifest `intent-filter`. The Flutter-era constant
 * `FLUTTER_NOTIFICATION_CLICK` is a no-op on this stack and misled reviewers.
 * See `.planning/verification/ISSUES-AND-SOLUTIONS.md#M9`.
 */
import { fcmService } from '../shared/services/fcm.service';

type AndroidNotificationShape = {
  priority: string;
  notification: {
    channelId: string;
    sound: string;
    clickAction?: string;
    visibility?: string;
  };
};

type FcmMessageShape = {
  notification: { title: string; body: string };
  data: Record<string, string>;
  android: AndroidNotificationShape;
  apns: unknown;
};

interface BuildMessageHost {
  buildMessage(
    notification: {
      type: string;
      title: string;
      body: string;
      priority?: 'high' | 'normal';
      data?: Record<string, string>;
    },
    tokens?: string[]
  ): FcmMessageShape;
}

describe('P1-M9: FCM payload drops legacy Flutter click-action', () => {
  const buildMessage = (fcmService as unknown as BuildMessageHost).buildMessage.bind(
    fcmService as unknown as BuildMessageHost
  );

  it('does not set android.notification.clickAction for high-priority notifications', () => {
    const msg = buildMessage({
      type: 'new_broadcast',
      title: 'New booking',
      body: 'A transporter is looking for a truck',
      priority: 'high',
      data: { orderId: 'abc-123' }
    });

    expect(msg.android.notification.clickAction).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(msg.android.notification, 'clickAction')).toBe(false);
  });

  it('does not set android.notification.clickAction for normal-priority notifications', () => {
    const msg = buildMessage({
      type: 'general',
      title: 'Ping',
      body: 'Hello',
      priority: 'normal'
    });

    expect(msg.android.notification.clickAction).toBeUndefined();
  });

  it('preserves the rest of the android.notification contract (channelId, sound)', () => {
    const msg = buildMessage({
      type: 'new_broadcast',
      title: 'New booking',
      body: 'Body',
      priority: 'high'
    });

    expect(msg.android.notification.channelId).toBe('broadcasts');
    expect(msg.android.notification.sound).toBe('default');
  });
});
