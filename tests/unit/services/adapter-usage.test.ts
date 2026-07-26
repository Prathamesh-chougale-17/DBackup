import { describe, it, expect } from 'vitest';
import { describeAdapterUsage, type AdapterUsage } from '@/services/adapters/adapter-service';

const noUsage: AdapterUsage = {
    jobsAsSource: [],
    jobsAsDestination: [],
    jobsAsDirectorySource: [],
    notificationTemplates: [],
};

const usage = (partial: Partial<AdapterUsage>): AdapterUsage => ({ ...noUsage, ...partial });

describe('describeAdapterUsage', () => {
    it('allows deletion when nothing references the adapter', () => {
        expect(describeAdapterUsage(noUsage)).toBeNull();
    });

    it('names the jobs that back up from the connection', () => {
        const message = describeAdapterUsage(usage({ jobsAsSource: ['Nightly Prod'] }));
        expect(message).toContain('Nightly Prod');
        expect(message).toContain('used in the following jobs');
    });

    it('names the jobs that write backups to the connection', () => {
        const message = describeAdapterUsage(usage({ jobsAsDestination: ['Weekly Archive'] }));
        expect(message).toContain('Weekly Archive');
    });

    it('lists a job once when it is both source and destination', () => {
        const message = describeAdapterUsage(usage({
            jobsAsSource: ['Mirror'],
            jobsAsDestination: ['Mirror'],
        }));
        expect(message?.match(/Mirror/g)).toHaveLength(1);
    });

    // Regression guard: directory sources are onDelete Restrict, so before this was
    // checked the delete surfaced a raw Prisma foreign key error as a 500.
    it('refuses when the connection is a directory source of a job', () => {
        const message = describeAdapterUsage(usage({ jobsAsDirectorySource: ['File Sync'] }));
        expect(message).toContain('File Sync');
        expect(message).toContain('directory source');
    });

    // Same regression guard for NotificationTemplateChannel.
    it('refuses when a notification template delivers through the connection', () => {
        const message = describeAdapterUsage(usage({ notificationTemplates: ['Ops Alerts'] }));
        expect(message).toContain('Ops Alerts');
        expect(message).toContain('notification templates');
    });

    it('reports every kind of usage at once', () => {
        const message = describeAdapterUsage({
            jobsAsSource: ['Nightly Prod'],
            jobsAsDestination: ['Weekly Archive'],
            jobsAsDirectorySource: ['File Sync'],
            notificationTemplates: ['Ops Alerts'],
        });
        expect(message).toContain('Nightly Prod');
        expect(message).toContain('Weekly Archive');
        expect(message).toContain('File Sync');
        expect(message).toContain('Ops Alerts');
    });
});
