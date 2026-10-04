/**
 * @file web-everything/web-everything#2708 — rebuilt from the REAL REST timeline (issues/2708/events, commits/6923e70/check-runs + check-suites), 2026-09-27. Webhook payloads trimmed to the fields the receiver reads. pull_requests on check events is [] exactly as the REST API returns it for this merged, branch-deleted PR; the pre-force-push head SHA is not recoverable, so early events carry head.sha null.
 */
export default {
 "source": "web-everything/web-everything#2708 — rebuilt from the REAL REST timeline (issues/2708/events, commits/6923e70/check-runs + check-suites), 2026-09-27. Webhook payloads trimmed to the fields the receiver reads. pull_requests on check events is [] exactly as the REST API returns it for this merged, branch-deleted PR; the pre-force-push head SHA is not recoverable, so early events carry head.sha null.",
 "deliveries": [
  {
   "at": "2026-09-26T01:17:46Z",
   "event": "pull_request",
   "delivery": "replay-2708-001",
   "payload": {
    "action": "opened",
    "number": 2708,
    "pull_request": {
     "number": 2708,
     "head": {
      "sha": null
     },
     "merged": false,
     "draft": false
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   }
  },
  {
   "at": "2026-09-26T01:18:37Z",
   "event": "pull_request",
   "delivery": "replay-2708-002",
   "payload": {
    "action": "labeled",
    "number": 2708,
    "pull_request": {
     "number": 2708,
     "head": {
      "sha": null
     },
     "merged": false,
     "draft": false
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    },
    "label": {
     "name": "checking"
    }
   }
  },
  {
   "at": "2026-09-26T01:27:07Z",
   "event": "pull_request",
   "delivery": "replay-2708-003",
   "payload": {
    "action": "unlabeled",
    "number": 2708,
    "pull_request": {
     "number": 2708,
     "head": {
      "sha": null
     },
     "merged": false,
     "draft": false
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    },
    "label": {
     "name": "checking"
    }
   }
  },
  {
   "at": "2026-09-26T01:27:08Z",
   "event": "pull_request",
   "delivery": "replay-2708-004",
   "payload": {
    "action": "labeled",
    "number": 2708,
    "pull_request": {
     "number": 2708,
     "head": {
      "sha": null
     },
     "merged": false,
     "draft": false
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    },
    "label": {
     "name": "ci:failed"
    }
   }
  },
  {
   "at": "2026-09-26T01:29:51Z",
   "event": "pull_request",
   "delivery": "replay-2708-005",
   "payload": {
    "action": "synchronize",
    "number": 2708,
    "pull_request": {
     "number": 2708,
     "head": {
      "sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588"
     },
     "merged": false,
     "draft": false
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   }
  },
  {
   "at": "2026-09-26T01:29:55Z",
   "event": "check_run",
   "payload": {
    "action": "completed",
    "check_run": {
     "name": "test-selection-measure",
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "skipped",
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-006"
  },
  {
   "at": "2026-09-26T01:29:55Z",
   "event": "check_run",
   "payload": {
    "action": "completed",
    "check_run": {
     "name": "visual",
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "skipped",
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-007"
  },
  {
   "at": "2026-09-26T01:30:08Z",
   "event": "check_run",
   "payload": {
    "action": "completed",
    "check_run": {
     "name": "daemon-soak",
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "success",
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-008"
  },
  {
   "at": "2026-09-26T01:30:09Z",
   "event": "pull_request",
   "delivery": "replay-2708-009",
   "payload": {
    "action": "unlabeled",
    "number": 2708,
    "pull_request": {
     "number": 2708,
     "head": {
      "sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588"
     },
     "merged": false,
     "draft": false
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    },
    "label": {
     "name": "ci:failed"
    }
   }
  },
  {
   "at": "2026-09-26T01:30:10Z",
   "event": "pull_request",
   "delivery": "replay-2708-010",
   "payload": {
    "action": "labeled",
    "number": 2708,
    "pull_request": {
     "number": 2708,
     "head": {
      "sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588"
     },
     "merged": false,
     "draft": false
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    },
    "label": {
     "name": "checking"
    }
   }
  },
  {
   "at": "2026-09-26T01:30:15Z",
   "event": "check_run",
   "payload": {
    "action": "completed",
    "check_run": {
     "name": "review-gate",
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "success",
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-011"
  },
  {
   "at": "2026-09-26T01:30:16Z",
   "event": "check_suite",
   "payload": {
    "action": "completed",
    "check_suite": {
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "success",
     "app": {
      "slug": "github-actions"
     },
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-012"
  },
  {
   "at": "2026-09-26T01:30:34Z",
   "event": "check_run",
   "payload": {
    "action": "completed",
    "check_run": {
     "name": "review-gate",
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "success",
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-013"
  },
  {
   "at": "2026-09-26T01:30:35Z",
   "event": "check_suite",
   "payload": {
    "action": "completed",
    "check_suite": {
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "success",
     "app": {
      "slug": "github-actions"
     },
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-014"
  },
  {
   "at": "2026-09-26T01:30:38Z",
   "event": "check_run",
   "payload": {
    "action": "completed",
    "check_run": {
     "name": "review-gate",
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "success",
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-015"
  },
  {
   "at": "2026-09-26T01:30:38Z",
   "event": "check_suite",
   "payload": {
    "action": "completed",
    "check_suite": {
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "success",
     "app": {
      "slug": "github-actions"
     },
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-016"
  },
  {
   "at": "2026-09-26T01:32:10Z",
   "event": "check_run",
   "payload": {
    "action": "completed",
    "check_run": {
     "name": "smoke",
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "success",
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-017"
  },
  {
   "at": "2026-09-26T01:32:12Z",
   "event": "check_run",
   "payload": {
    "action": "completed",
    "check_run": {
     "name": "test-shard (1)",
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "success",
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-018"
  },
  {
   "at": "2026-09-26T01:32:16Z",
   "event": "check_run",
   "payload": {
    "action": "completed",
    "check_run": {
     "name": "test-shard (4)",
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "success",
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-019"
  },
  {
   "at": "2026-09-26T01:32:19Z",
   "event": "check_run",
   "payload": {
    "action": "completed",
    "check_run": {
     "name": "test-shard (2)",
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "success",
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-020"
  },
  {
   "at": "2026-09-26T01:33:00Z",
   "event": "check_run",
   "payload": {
    "action": "completed",
    "check_run": {
     "name": "test-shard (3)",
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "success",
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-021"
  },
  {
   "at": "2026-09-26T01:39:07Z",
   "event": "check_run",
   "payload": {
    "action": "completed",
    "check_run": {
     "name": "test",
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "success",
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-022"
  },
  {
   "at": "2026-09-26T01:39:08Z",
   "event": "check_suite",
   "payload": {
    "action": "completed",
    "check_suite": {
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "success",
     "app": {
      "slug": "github-actions"
     },
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-023"
  },
  {
   "at": "2026-09-26T01:39:18Z",
   "event": "pull_request",
   "delivery": "replay-2708-024",
   "payload": {
    "action": "labeled",
    "number": 2708,
    "pull_request": {
     "number": 2708,
     "head": {
      "sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588"
     },
     "merged": false,
     "draft": false
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    },
    "label": {
     "name": "ready-to-merge"
    }
   }
  },
  {
   "at": "2026-09-26T01:39:19Z",
   "event": "pull_request",
   "delivery": "replay-2708-025",
   "payload": {
    "action": "unlabeled",
    "number": 2708,
    "pull_request": {
     "number": 2708,
     "head": {
      "sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588"
     },
     "merged": false,
     "draft": false
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    },
    "label": {
     "name": "checking"
    }
   }
  },
  {
   "at": "2026-09-26T01:39:36Z",
   "event": "pull_request",
   "delivery": "replay-2708-026",
   "payload": {
    "action": "unlabeled",
    "number": 2708,
    "pull_request": {
     "number": 2708,
     "head": {
      "sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588"
     },
     "merged": false,
     "draft": false
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    },
    "label": {
     "name": "ready-to-merge"
    }
   }
  },
  {
   "at": "2026-09-26T01:39:38Z",
   "event": "pull_request",
   "delivery": "replay-2708-027",
   "payload": {
    "action": "labeled",
    "number": 2708,
    "pull_request": {
     "number": 2708,
     "head": {
      "sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588"
     },
     "merged": false,
     "draft": false
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    },
    "label": {
     "name": "review:pending"
    }
   }
  },
  {
   "at": "2026-09-26T01:39:40Z",
   "event": "check_run",
   "payload": {
    "action": "completed",
    "check_run": {
     "name": "review-gate",
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "success",
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-028"
  },
  {
   "at": "2026-09-26T01:39:41Z",
   "event": "check_suite",
   "payload": {
    "action": "completed",
    "check_suite": {
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "success",
     "app": {
      "slug": "github-actions"
     },
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-029"
  },
  {
   "at": "2026-09-26T01:39:48Z",
   "event": "check_run",
   "payload": {
    "action": "completed",
    "check_run": {
     "name": "review-gate",
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "success",
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-030"
  },
  {
   "at": "2026-09-26T01:39:49Z",
   "event": "check_suite",
   "payload": {
    "action": "completed",
    "check_suite": {
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "success",
     "app": {
      "slug": "github-actions"
     },
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-031"
  },
  {
   "at": "2026-09-26T01:40:04Z",
   "event": "check_run",
   "payload": {
    "action": "completed",
    "check_run": {
     "name": "review-gate",
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "failure",
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-032"
  },
  {
   "at": "2026-09-26T01:40:04Z",
   "event": "check_suite",
   "payload": {
    "action": "completed",
    "check_suite": {
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "failure",
     "app": {
      "slug": "github-actions"
     },
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-033"
  },
  {
   "at": "2026-09-26T01:40:07Z",
   "event": "check_run",
   "payload": {
    "action": "completed",
    "check_run": {
     "name": "review-gate",
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "success",
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-034"
  },
  {
   "at": "2026-09-26T01:40:07Z",
   "event": "check_suite",
   "payload": {
    "action": "completed",
    "check_suite": {
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "success",
     "app": {
      "slug": "github-actions"
     },
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-035"
  },
  {
   "at": "2026-09-26T02:01:34Z",
   "event": "pull_request",
   "delivery": "replay-2708-036",
   "payload": {
    "action": "labeled",
    "number": 2708,
    "pull_request": {
     "number": 2708,
     "head": {
      "sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588"
     },
     "merged": false,
     "draft": false
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    },
    "label": {
     "name": "review-round:1"
    }
   }
  },
  {
   "at": "2026-09-26T02:01:37Z",
   "event": "pull_request",
   "delivery": "replay-2708-037",
   "payload": {
    "action": "labeled",
    "number": 2708,
    "pull_request": {
     "number": 2708,
     "head": {
      "sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588"
     },
     "merged": false,
     "draft": false
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    },
    "label": {
     "name": "review-status:reviewing"
    }
   }
  },
  {
   "at": "2026-09-26T02:01:55Z",
   "event": "check_run",
   "payload": {
    "action": "completed",
    "check_run": {
     "name": "review-gate",
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "failure",
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-038"
  },
  {
   "at": "2026-09-26T02:01:56Z",
   "event": "check_suite",
   "payload": {
    "action": "completed",
    "check_suite": {
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "failure",
     "app": {
      "slug": "github-actions"
     },
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-039"
  },
  {
   "at": "2026-09-26T02:02:04Z",
   "event": "check_run",
   "payload": {
    "action": "completed",
    "check_run": {
     "name": "review-gate",
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "failure",
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-040"
  },
  {
   "at": "2026-09-26T02:02:04Z",
   "event": "check_suite",
   "payload": {
    "action": "completed",
    "check_suite": {
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "failure",
     "app": {
      "slug": "github-actions"
     },
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-041"
  },
  {
   "at": "2026-09-26T02:12:09Z",
   "event": "pull_request",
   "delivery": "replay-2708-042",
   "payload": {
    "action": "unlabeled",
    "number": 2708,
    "pull_request": {
     "number": 2708,
     "head": {
      "sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588"
     },
     "merged": false,
     "draft": false
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    },
    "label": {
     "name": "review:pending"
    }
   }
  },
  {
   "at": "2026-09-26T02:12:09Z",
   "event": "pull_request",
   "delivery": "replay-2708-043",
   "payload": {
    "action": "labeled",
    "number": 2708,
    "pull_request": {
     "number": 2708,
     "head": {
      "sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588"
     },
     "merged": false,
     "draft": false
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    },
    "label": {
     "name": "review:accepted"
    }
   }
  },
  {
   "at": "2026-09-26T02:12:32Z",
   "event": "check_run",
   "payload": {
    "action": "completed",
    "check_run": {
     "name": "review-gate",
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "success",
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-044"
  },
  {
   "at": "2026-09-26T02:12:32Z",
   "event": "check_suite",
   "payload": {
    "action": "completed",
    "check_suite": {
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "success",
     "app": {
      "slug": "github-actions"
     },
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-045"
  },
  {
   "at": "2026-09-26T02:12:37Z",
   "event": "check_run",
   "payload": {
    "action": "completed",
    "check_run": {
     "name": "review-gate",
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "success",
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-046"
  },
  {
   "at": "2026-09-26T02:12:38Z",
   "event": "check_suite",
   "payload": {
    "action": "completed",
    "check_suite": {
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "success",
     "app": {
      "slug": "github-actions"
     },
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-047"
  },
  {
   "at": "2026-09-26T02:13:12Z",
   "event": "pull_request",
   "delivery": "replay-2708-048",
   "payload": {
    "action": "labeled",
    "number": 2708,
    "pull_request": {
     "number": 2708,
     "head": {
      "sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588"
     },
     "merged": false,
     "draft": false
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    },
    "label": {
     "name": "ready-to-merge"
    }
   }
  },
  {
   "at": "2026-09-26T02:13:32Z",
   "event": "pull_request",
   "delivery": "replay-2708-049",
   "payload": {
    "action": "closed",
    "number": 2708,
    "pull_request": {
     "number": 2708,
     "head": {
      "sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588"
     },
     "merged": true,
     "draft": false
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   }
  },
  {
   "at": "2026-09-26T02:13:35Z",
   "event": "check_run",
   "payload": {
    "action": "completed",
    "check_run": {
     "name": "review-gate",
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "success",
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-050"
  },
  {
   "at": "2026-09-26T02:13:36Z",
   "event": "check_suite",
   "payload": {
    "action": "completed",
    "check_suite": {
     "head_sha": "6923e70bf4d0223a92f7d719f93a488ff7eee588",
     "conclusion": "success",
     "app": {
      "slug": "github-actions"
     },
     "pull_requests": []
    },
    "repository": {
     "full_name": "web-everything/web-everything"
    }
   },
   "delivery": "replay-2708-051"
  }
 ]
};
