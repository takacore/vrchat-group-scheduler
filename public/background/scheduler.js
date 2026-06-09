// background/scheduler.js
export const scheduler = {
    async addJob(postId, timestamp) {
        chrome.alarms.create(postId, { when: timestamp });
        console.log(`Scheduled post ${postId} for ${new Date(timestamp).toLocaleString()}`);
    },

    async removeJob(postId) {
        chrome.alarms.clear(postId);
        console.log(`Removed scheduled post ${postId}`);
    },

    async getJobs() {
        return new Promise((resolve) => {
            chrome.alarms.getAll((alarms) => {
                resolve(alarms);
            });
        });
    }
};
