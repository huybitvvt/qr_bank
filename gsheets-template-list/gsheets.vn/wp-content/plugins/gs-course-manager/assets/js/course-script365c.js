jQuery(document).ready(function ($) {
    // Open course modal when clicking on course card
    $(".cm-course-card").on("click", function () {
        var courseId = $(this).data("course-id");
        $("#course-modal-" + courseId).addClass("active");
        $("body").css({ "overflow": "hidden", "position": "fixed", "width": "100%" });

        // Ensure first chapter is opened by default
        var $modal = $("#course-modal-" + courseId);
        $modal.find(".cm-chapter:first-child .cm-chapter-title").addClass("active");
        $modal.find(".cm-chapter:first-child .cm-chapter-lessons").addClass("active").show();

        // Collapse features by default
        $modal.find(".cm-course-features").removeClass("active");
    });

    // Close course modal
    $(".cm-course-modal-close").on("click", function () {
        $(this).closest(".cm-course-modal").removeClass("active");
        $("body").css({ "overflow": "", "position": "", "width": "" });
    });

    // Close when clicking outside modal content
    $(".cm-course-modal").on("click", function (e) {
        if ($(e.target).hasClass("cm-course-modal")) {
            $(this).removeClass("active");
            $("body").css({ "overflow": "", "position": "", "width": "" });
        }
    });

    // Close modal with ESC key
    $(document).on("keydown", function (e) {
        if (e.key === "Escape") {
            $(".cm-course-modal").removeClass("active");
            $("body").css({ "overflow": "", "position": "", "width": "" });
        }
    });

    // Toggle features
    $(".cm-course-features-header").on("click", function () {
        $(this).toggleClass("active");
        var $features = $(this).next(".cm-course-features");

        if ($(this).hasClass("active")) {
            $features.slideDown(400, "swing");
        } else {
            $features.slideUp(400, "swing");
        }
    });

    // Toggle chapter accordion
    $(".cm-chapter-title").on("click", function () {
        var $this = $(this);
        var $chapter = $this.closest(".cm-chapter");
        var $lessons = $this.next(".cm-chapter-lessons");

        if ($this.hasClass("active")) {
            // Đóng chương hiện tại nếu đang mở
            $this.removeClass("active");
            $lessons.slideUp(400, "swing");
        } else {
            // Đóng TẤT CẢ các chương đang mở
            $(".cm-chapter-title.active").removeClass("active");
            $(".cm-chapter-lessons.active").slideUp(400, "swing").removeClass("active");

            // Mở chương được click
            $this.addClass("active");
            $lessons.addClass("active").slideDown(400, "swing");
        }
    });

    // Function to save viewed lessons in localStorage
    function saveViewedLesson(lessonId) {
        var viewedLessons = localStorage.getItem("cmViewedLessons");
        viewedLessons = viewedLessons ? JSON.parse(viewedLessons) : [];

        if (!viewedLessons.includes(lessonId)) {
            viewedLessons.push(lessonId);
            localStorage.setItem("cmViewedLessons", JSON.stringify(viewedLessons));
        }
    }

    // Function to mark lessons as viewed
    function markViewedLessons() {
        var viewedLessons = localStorage.getItem("cmViewedLessons");

        if (viewedLessons) {
            viewedLessons = JSON.parse(viewedLessons);

            viewedLessons.forEach(function (lessonId) {
                $(".cm-lesson-item[data-video-id='" + lessonId + "']").addClass("viewed");
            });
        }
    }

    // Open lesson video modal
    // Open lesson video modal
    $(".cm-lesson-item").on("click", function (e) {
        e.stopPropagation();
        var $lessonItem = $(this);

        // Check if video exists
        if ($lessonItem.hasClass('no-video')) {
            return;
        }

        var videoType = $lessonItem.data("video-type");
        var videoId = $lessonItem.data("video-id");
        var lessonTitle = $lessonItem.data("lesson-title");
        var videoSrc = "";

        if (videoType === 'youtube') {
            videoSrc = "https://www.youtube.com/embed/" + videoId + "?autoplay=1";
        } else {
            videoSrc = "https://drive.google.com/file/d/" + videoId + "/preview";
        }

        // Update modal title
        $("#cmModalTitle").text(lessonTitle);

        // Add loading state
        var lessonTitleElem = $lessonItem.find(".cm-lesson-title");
        var originalContent = lessonTitleElem.html();
        lessonTitleElem.html('<span class="cm-loading"></span>Đang tải...');

        // Mark as viewed and save
        $lessonItem.addClass("viewed");
        saveViewedLesson(videoId);

        // Load the video
        $("#cmModalVideoFrame").attr("src", videoSrc);
        $("#cmVideoModal").css("display", "block");

        // Show the modal with animation
        setTimeout(function () {
            $("#cmVideoModal").addClass("show");
            // Remove loading state after showing modal
            lessonTitleElem.html(originalContent);
        }, 50);
    });

    // Close video modal
    $(".cm-close-modal").on("click", function () {
        closeVideoModal();
    });

    // Close video modal when clicking outside
    $("#cmVideoModal").on("click", function (event) {
        if ($(event.target).is("#cmVideoModal")) {
            closeVideoModal();
        }
    });

    // Close video modal with ESC key
    $(document).on("keydown", function (event) {
        if (event.key === "Escape" && $("#cmVideoModal").is(":visible")) {
            closeVideoModal();
        }
    });

    // Function to close video modal
    function closeVideoModal() {
        $("#cmVideoModal").removeClass("show");

        setTimeout(function () {
            $("#cmVideoModal").css("display", "none");
            $("#cmModalVideoFrame").attr("src", "");
        }, 300);
    }

    // Mark lessons as viewed on page load
    markViewedLessons();

    // Mở chương đầu tiên mặc định
    $(".cm-chapter:first-child .cm-chapter-title").addClass("active");
    $(".cm-chapter:first-child .cm-chapter-lessons").addClass("active").show();

    // Mở features mặc định
    $(".cm-course-features-header").addClass("active");
    $(".cm-course-features").addClass("active").show();
});