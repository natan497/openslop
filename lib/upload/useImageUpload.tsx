"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { stringifyError } from "@/lib/errors";
import { uploadImage } from "@/lib/upload/uploadImage";

export function useImageUpload({
	onUpload,
	multiple = false,
}: {
	onUpload: (urls: string[]) => void;
	multiple?: boolean;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [uploadingCount, setUploadingCount] = useState(0);

	// An upload outlives the render that started it, so the callback captured at
	// file-pick time would commit against whatever the element looked like then.
	const onUploadRef = useRef(onUpload);
	useEffect(() => {
		onUploadRef.current = onUpload;
	});

	const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(e.target.files ?? []);
		if (files.length === 0) return;
		setUploadingCount(files.length);
		try {
			const results = await Promise.allSettled(files.map(uploadImage));
			const urls: string[] = [];
			for (const r of results) {
				if (r.status === "fulfilled") urls.push(r.value);
				else toast.error(stringifyError(r.reason));
			}
			if (urls.length > 0) onUploadRef.current(urls);
		} finally {
			setUploadingCount(0);
			if (inputRef.current) inputRef.current.value = "";
		}
	};

	const inputElement = (
		<input
			ref={inputRef}
			type="file"
			accept="image/*"
			multiple={multiple}
			className="hidden"
			onChange={handleFileChange}
		/>
	);

	return {
		openPicker: () => inputRef.current?.click(),
		uploading: uploadingCount > 0,
		uploadingCount,
		inputElement,
	};
}
