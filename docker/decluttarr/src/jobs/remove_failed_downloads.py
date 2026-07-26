from src.jobs.removal_job import RemovalJob
from src.utils.log_setup import logger
from src.utils.wanted_manager import WantedManager


class RemoveFailedDownloads(RemovalJob):
    queue_scope = "normal"
    blocklist = True

    async def run(self) -> int:
        removed_count = await super().run()
        if removed_count == 0:
            return removed_count

        detail_ids = sorted(
            {
                item.get("detail_item_id")
                for item in self.affected_downloads.values()
                if item.get("detail_item_id")
            }
        )
        if not detail_ids or not self.arr.detail_item_search_command:
            return removed_count

        logger.info(
            "Job '%s' triggered replacement search for %d %s item(s)",
            self.job_name,
            len(detail_ids),
            self.arr.detail_item_key,
        )
        await WantedManager(self.arr, self.settings).search_items(detail_ids)
        return removed_count

    async def _find_affected_items(self):
        return self.queue_manager.filter_queue(self.queue, ["failed"])
